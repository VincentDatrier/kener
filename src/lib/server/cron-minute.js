// @ts-nocheck
import axios from "axios";
import { Ping, ExtractIPv6HostAndPort, TCP } from "./ping.js";
import { UP, DOWN, DEGRADED } from "./constants.js";
import {
	GetMinuteStartNowTimestampUTC,
	ReplaceAllOccurrences,
	GetRequiredSecrets,
	Wait
} from "./tool.js";

import alerting from "./alerting.js";
import Queue from "queue";
import dotenv from "dotenv";
import path from "path";
import db from "./db/db.js";
import notification from "./notification/notif.js";
import DNSResolver from "./dns.js";

dotenv.config();

const REALTIME = "realtime";
const TIMEOUT = "timeout";
const ERROR = "error";
const MANUAL = "manual";

const alertingQueue = new Queue({
	concurrency: 10, // Number of tasks that can run concurrently
	timeout: 10000, // Timeout in ms after which a task will be considered as failed (optional)
	autostart: true // Automatically start the queue (optional)
});
const apiQueue = new Queue({
	concurrency: 10, // Number of tasks that can run concurrently
	timeout: 10000, // Timeout in ms after which a task will be considered as failed (optional)
	autostart: true // Automatically start the queue (optional)
});

const defaultEval = `(async function (statusCode, responseTime, responseData) {
	let statusCodeShort = Math.floor(statusCode/100);
    if(statusCode == 429 || (statusCodeShort >=2 && statusCodeShort <= 3)) {
        return {
			status: 'UP',
			latency: responseTime,
        }
    } 
	return {
		status: 'DOWN',
		latency: responseTime,
	}
})`;

const defaultPingEval = `(async function (responseDataBase64) {
	let arrayOfPings = JSON.parse(atob(responseDataBase64));
	let latencyTotal = arrayOfPings.reduce((acc, ping) => {
		return acc + ping.latency;
	}, 0);

	let alive = arrayOfPings.reduce((acc, ping) => {
		return acc && ping.alive;
	}, true);

	return {
		status: alive ? 'UP' : 'DOWN',
		latency: latencyTotal / arrayOfPings.length,
	}
})`;
const defaultTcpEval = `(async function (responseDataBase64) {
	let arrayOfPings = JSON.parse(atob(responseDataBase64));
	let latencyTotal = arrayOfPings.reduce((acc, ping) => {
		return acc + ping.latency;
	}, 0);

	let alive = arrayOfPings.reduce((acc, ping) => {
		if (ping.status === "open") {
			return acc && true;
		} else {
			return false;
		}
	}, true);

	return {
		status: alive ? 'UP' : 'DOWN',
		latency: latencyTotal / arrayOfPings.length,
	}
})`;

async function manualIncident(monitor) {
	let startTs = GetMinuteStartNowTimestampUTC();
	let incidentArr = await db.getIncidentsByMonitorTagRealtime(monitor.tag, startTs);
	let maintenanceArr = await db.getMaintenanceByMonitorTagRealtime(monitor.tag, startTs);

	let impactArr = incidentArr.concat(maintenanceArr);

	let impact = "";
	if (impactArr.length == 0) {
		return {};
	}

	for (let i = 0; i < impactArr.length; i++) {
		const element = impactArr[i];

		let autoIncidents = await db.getActiveAlertIncident(
			monitor.tag,
			element.monitor_impact,
			element.id
		);

		if (!!autoIncidents) {
			continue;
		}

		if (element.monitor_impact === "DOWN") {
			impact = "DOWN";
			break;
		}
		if (element.monitor_impact === "DEGRADED") {
			impact = "DEGRADED";
		}
	}

	if (impact === "") {
		return {};
	}

	let manualData = {
		[startTs]: {
			status: impact,
			latency: 0,
			type: MANUAL
		}
	};
	return manualData;
}

const tcpCall = async (hosts, tcpEval, tag) => {
	let arrayOfPings = [];
	for (let i = 0; i < hosts.length; i++) {
		const host = hosts[i];
		arrayOfPings.push(await TCP(host.type, host.host, host.port, host.timeout));
	}
	let respBase64 = Buffer.from(JSON.stringify(arrayOfPings)).toString("base64");

	let evalResp = undefined;

	try {
		evalResp = await eval(tcpEval + `("${respBase64}")`);
	} catch (error) {
		console.log(`Error in tcpEval for ${tag}`, error.message);
	}
	//reduce to get the status
	return {
		status: evalResp.status,
		latency: evalResp.latency,
		type: REALTIME
	};
};
const pingCall = async (hosts, pingEval, tag) => {
	let arrayOfPings = [];
	for (let i = 0; i < hosts.length; i++) {
		const host = hosts[i];
		arrayOfPings.push(await Ping(host.type, host.host, host.timeout, host.count));
	}
	let respBase64 = Buffer.from(JSON.stringify(arrayOfPings)).toString("base64");

	let evalResp = undefined;

	try {
		evalResp = await eval(pingEval + `("${respBase64}")`);
	} catch (error) {
		console.log(`Error in pingEval for ${tag}`, error.message);
	}
	//reduce to get the status
	return {
		status: evalResp.status,
		latency: evalResp.latency,
		type: REALTIME
	};
};
const apiCall = async (envSecrets, url, method, headers, body, timeout, monitorEval, tag) => {
	let axiosHeaders = {};
	axiosHeaders["User-Agent"] = "Kener/3.0.2";
	axiosHeaders["Accept"] = "*/*";
	const start = Date.now();
	//replace all secrets
	for (let i = 0; i < envSecrets.length; i++) {
		const secret = envSecrets[i];
		if (!!body) {
			body = ReplaceAllOccurrences(body, secret.find, secret.replace);
		}
		if (!!url) {
			url = ReplaceAllOccurrences(url, secret.find, secret.replace);
		}
		if (!!headers) {
			headers = ReplaceAllOccurrences(headers, secret.find, secret.replace);
		}
	}
	if (!!headers) {
		headers = JSON.parse(headers);
		headers = headers.reduce((acc, header) => {
			acc[header.key] = header.value;
			return acc;
		}, {});
		axiosHeaders = { ...axiosHeaders, ...headers };
	}

	const options = {
		method: method,
		headers: headers,
		timeout: timeout,
		transformResponse: (r) => r
	};
	if (!!headers) {
		options.headers = headers;
	}
	if (!!body) {
		options.data = body;
	}
	let statusCode = 500;
	let latency = 0;
	let resp = "";
	let timeoutError = false;
	try {
		let data = await axios(url, options);
		statusCode = data.status;
		resp = data.data;
	} catch (err) {
		console.log(`Error in apiCall ${tag}`, err.message);
		if (err.message.startsWith("timeout of") && err.message.endsWith("exceeded")) {
			timeoutError = true;
		}
		if (err.response !== undefined && err.response.status !== undefined) {
			statusCode = err.response.status;
		}
		if (err.response !== undefined && err.response.data !== undefined) {
			resp = err.response.data;
		} else {
			resp = JSON.stringify(resp);
		}
	} finally {
		const end = Date.now();
		latency = end - start;
		if (resp === undefined || resp === null) {
			resp = "";
		}
	}
	resp = Buffer.from(resp).toString("base64");

	let evalResp = undefined;

	try {
		evalResp = await eval(monitorEval + `(${statusCode}, ${latency}, "${resp}")`);
	} catch (error) {
		console.log(`Error in monitorEval for ${tag}`, error.message);
	}

	if (evalResp === undefined || evalResp === null) {
		evalResp = {
			status: DOWN,
			latency: latency,
			type: ERROR
		};
	} else if (
		evalResp.status === undefined ||
		evalResp.status === null ||
		[UP, DOWN, DEGRADED].indexOf(evalResp.status) === -1
	) {
		evalResp = {
			status: DOWN,
			latency: latency,
			type: ERROR
		};
	} else {
		evalResp.type = REALTIME;
	}

	let toWrite = {
		status: DOWN,
		latency: latency,
		type: ERROR
	};
	if (evalResp.status !== undefined && evalResp.status !== null) {
		toWrite.status = evalResp.status;
	}
	if (evalResp.latency !== undefined && evalResp.latency !== null) {
		toWrite.latency = evalResp.latency;
	}
	if (evalResp.type !== undefined && evalResp.type !== null) {
		toWrite.type = evalResp.type;
	}
	if (timeoutError) {
		toWrite.type = TIMEOUT;
	}

	return toWrite;
};

async function dsnChecker(dnsResolver, host, recordType, matchType, values) {
	try {
		let queryStartTime = Date.now();
		let dnsRes = await dnsResolver.getRecord(host, recordType);
		let latency = Date.now() - queryStartTime;

		if (dnsRes[recordType] === undefined) {
			return {
				status: DOWN,
				latency: latency,
				type: REALTIME
			};
		}
		let data = dnsRes[recordType];
		let dnsData = data.map((d) => d.data);
		if (matchType === "ALL") {
			for (let i = 0; i < values.length; i++) {
				if (dnsData.indexOf(values[i].trim()) === -1) {
					return {
						status: DOWN,
						latency: latency,
						type: REALTIME
					};
				}
			}
			return {
				status: UP,
				latency: latency,
				type: REALTIME
			};
		} else if (matchType === "ANY") {
			for (let i = 0; i < values.length; i++) {
				if (dnsData.indexOf(values[i].trim()) !== -1) {
					return {
						status: UP,
						latency: latency,
						type: REALTIME
					};
				}
			}
			return {
				status: DOWN,
				latency: latency,
				type: REALTIME
			};
		}
	} catch (error) {
		console.log("Error in dnsChecker", error);
		return {
			status: DOWN,
			latency: 0,
			type: REALTIME
		};
	}
}

const Minuter = async (monitor) => {
	let realTimeData = {};
	let manualData = {};

	const startOfMinute = GetMinuteStartNowTimestampUTC();
	if (monitor.monitor_type === "API") {
		let envSecrets = GetRequiredSecrets(
			`${monitor.type_data.url} ${monitor.type_data.body} ${JSON.stringify(monitor.type_data.headers)}`
		);

		if (monitor.type_data.eval === "") {
			monitor.type_data.eval = defaultEval;
		}

		let apiResponse = await apiCall(
			envSecrets,
			monitor.type_data.url,
			monitor.type_data.method,
			JSON.stringify(monitor.type_data.headers),
			monitor.type_data.body,
			monitor.type_data.timeout,
			monitor.type_data.eval,
			monitor.tag
		);

		realTimeData[startOfMinute] = apiResponse;
		if (apiResponse.type === TIMEOUT) {
			apiQueue.push(async (cb) => {
				await Wait(500); //wait for 500ms
				console.log(
					"Retrying api call for " +
						monitor.name +
						" at " +
						startOfMinute +
						" due to timeout"
				);
				apiCall(
					envSecrets,
					monitor.type_data.url,
					monitor.type_data.method,
					JSON.stringify(monitor.type_data.headers),
					monitor.type_data.body,
					monitor.type_data.timeout,
					monitor.type_data.eval,
					monitor.tag
				).then(async (data) => {
					await db.insertMonitoringData({
						monitor_tag: monitor.tag,
						timestamp: startOfMinute,
						status: data.status,
						latency: data.latency,
						type: data.type
					});
					cb();
				});
			});
		}
	} else if (monitor.monitor_type === "PING") {
		if (!!!monitor.type_data.pingEval) {
			monitor.type_data.pingEval = defaultPingEval;
		}
		let pingResponse = await pingCall(
			monitor.type_data.hosts,
			monitor.type_data.pingEval,
			monitor.tag
		);
		realTimeData[startOfMinute] = pingResponse;
	} else if (monitor.monitor_type === "TCP") {
		if (!!!monitor.type_data.tcpEval) {
			monitor.type_data.tcpEval = defaultTcpEval;
		}
		let pingResponse = await tcpCall(
			monitor.type_data.hosts,
			monitor.type_data.tcpEval,
			monitor.tag
		);
		realTimeData[startOfMinute] = pingResponse;
	} else if (monitor.monitor_type === "DNS") {
		const dnsResolver = new DNSResolver(monitor.type_data.nameServer);
		let dnsResponse = await dsnChecker(
			dnsResolver,
			monitor.type_data.host,
			monitor.type_data.lookupRecord,
			monitor.type_data.matchType,
			monitor.type_data.values
		);
		realTimeData[startOfMinute] = dnsResponse;
	}

	manualData = await manualIncident(monitor);
	//merge noData, apiData, webhookData, dayData
	let mergedData = {};

	if (monitor.default_status !== undefined && monitor.default_status !== null) {
		if ([UP, DOWN, DEGRADED].indexOf(monitor.default_status) !== -1) {
			mergedData[startOfMinute] = {
				status: monitor.default_status,
				latency: 0,
				type: "default_status"
			};
		}
	}

	for (const timestamp in realTimeData) {
		mergedData[timestamp] = realTimeData[timestamp];
	}

	for (const timestamp in manualData) {
		mergedData[timestamp] = manualData[timestamp];
	}

	for (const timestamp in mergedData) {
		const element = mergedData[timestamp];
		db.insertMonitoringData({
			monitor_tag: monitor.tag,
			timestamp: parseInt(timestamp),
			status: element.status,
			latency: element.latency,
			type: element.type
		});
	}
	alertingQueue.push(async (cb) => {
		setTimeout(async () => {
			await alerting(monitor);
			cb();
		}, 1042);
	});
};

alertingQueue.start((err) => {
	if (err) {
		console.error("Error occurred:", err);
		process.exit(1);
	}
});
apiQueue.start((err) => {
	if (err) {
		console.error("Error occurred:", err);
		process.exit(1);
	}
});
export { Minuter };
