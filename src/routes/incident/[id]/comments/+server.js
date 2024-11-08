// @ts-nocheck
// @ts-ignore
import { json } from "@sveltejs/kit";
import fs from "fs-extra";
import { GetCommentsForIssue } from "$lib/server/github.js";
import { marked } from "marked";
import siteJSON from "$lib/server/data/site.json?raw";

export async function GET({ params }) {
	const incidentNumber = params.id;
	let siteData = JSON.parse(siteJSON);
	let comments = await GetCommentsForIssue(incidentNumber, siteData.github);
	comments = comments.map(
		(
			/** @type {{ body: string | import("markdown-it/lib/token")[]; created_at: any; updated_at: any; html_url: any; }} */ comment
		) => {
			const html = marked.parse(comment.body);
			return {
				body: html,
				created_at: comment.created_at,
				updated_at: comment.updated_at,
				html_url: comment.html_url
			};
		}
	);

	return json(comments);
}
