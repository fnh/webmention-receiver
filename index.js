#!/usr/bin/env node

import http from "http";

import { readFile, writeFile } from "node:fs/promises";
import path from "path";
import { fileURLToPath } from 'url';

let __dirname = path.dirname(fileURLToPath(import.meta.url));

let DEBUG = false;

let PORT = 12117;

let ALLOWED_TARGET_BASE_URLS = [];

let BAD_REQUEST_PREDICATES = [
    ({ request }) => request.method !== "POST",
    ({ request }) => !request.headers,
    ({ request }) =>
        request.headers["content-type"] !== "application/x-www-form-urlencoded",

    ({ payload }) => !payload,
    ({ payload }) => !payload.get("source"),
    ({ payload }) => !payload.get("target"),

    ({ payload }) => payload.get("target") === payload.get("source"),

    ({ payload }) => !URL.canParse(payload.get("source")),
    ({ payload }) => !URL.canParse(payload.get("target")),

    ({ payload }) =>
        ALLOWED_TARGET_BASE_URLS.length > 0
        && !ALLOWED_TARGET_BASE_URLS.some(
            target => payload.get("target").startsWith(target)
        ),

    ({ payload }) =>
        !(payload.get("target").startsWith("https://")
            || payload.get("target").startsWith("http://"))

];

function isValid(request, body) {
    let payload = new URLSearchParams(body);

    let isBadRequest =
        BAD_REQUEST_PREDICATES.some(isBad =>
            isBad({ request, payload })
        );

    if (isBadRequest && DEBUG) {
        let violatedRule =
            BAD_REQUEST_PREDICATES.findIndex(isBad =>
                isBad({ request, payload })
            );

        console.log({ violatedRule, payload });
    }

    return !isBadRequest;
}

function toMention(body) {
    let payload = new URLSearchParams(body);

    return {
        source: payload.get("source"),
        target: payload.get("target"),
    }
}

async function getBody(request) {
    return new Promise((resolve) => {
        let body = [];
        request.on("data", chunk => {
            body.push(chunk);
        });

        request.on("end", () => {
            let result = Buffer.concat(body).toString();
            resolve(result);
        });
    });
}

const server = http.createServer((request, response) => {
    let content = getBody(request);

    content.then((body) => {
        if (isValid(request, body)) {
            let mention = toMention(body);

            if (isEnqueueable(mention)) {
                queue.push(mention);
                response.writeHead(202);
            } else {
                response.writeHead(500);
            }
        } else {
            response.writeHead(400);
        }
        response.end();
    }).catch(() => {
        response.writeHead(500);
        response.end();
    });
});

let commandLineArgs = process.argv.slice(2);

let [
    mentionsFile,
    failureFile,
    allowedBaseUrlsFile,
] = commandLineArgs;

if (!mentionsFile) {
    mentionsFile = "webmentions.json";
}

if (!failureFile) {
    failureFile = "validation-failures.json";
}

let storedFailures =
    await readFile(path.resolve(__dirname, failureFile), { encoding: "utf-8" });

let storedMentions =
    await readFile(path.resolve(__dirname, mentionsFile), { encoding: "utf-8" });

let received = JSON.parse(storedMentions);
let failures = JSON.parse(storedFailures);

if (allowedBaseUrlsFile) {
    let allowList =
        await readFile(
            path.resolve(__dirname, allowedBaseUrlsFile),
            { encoding: "utf-8" }
        );

    ALLOWED_TARGET_BASE_URLS = JSON.parse(allowList).urls;
}

let queue = [];

console.log("starting webmention-receiver on port " + PORT);
server.listen(PORT);

function isDuplicate(mention) {
    return function (existing) {
        return existing.source === mention.source
            && existing.target === mention.target;
    }
}

function isEnqueueable(mention) {
    let alreadyEnqueued = queue.find(isDuplicate(mention));
    if (alreadyEnqueued) {
        return false;
    }

    let failedValidations = failures[mention.source];

    if (failedValidations && failedValidations > 5) {
        return false;
    }

    let alreadyValidated =
        received.webmentions.find(isDuplicate(mention));

    if (alreadyValidated) {
        let elapsedTime = Date.now() - alreadyValidated.validatedAt;
        if (elapsedTime < (24 * 60 * 60 * 1000)) {
            return false;
        }
    }

    return true;
}

async function validateMention() {
    if (!queue.length) {
        return;
    }

    let mention = queue.shift();

    let response =
        await fetch(mention.source)
            .catch((e) => console.error(e));

    if (response?.ok) {
        const data = await response.text();

        // only a heuristic - prone to false-postives!
        let isMentioned = data?.includes(mention.target);

        received.webmentions.push({
            ...mention,
            validated: true,
            mentioned: isMentioned,
            validatedAt: Date.now()
        });

        await writeFile(
            path.resolve(__dirname, mentionsFile),
            JSON.stringify(received)
        );
    } else if (response?.status === 410) {
        received.webmentions.push({
            ...mention,
            validated: true,
            deleted: true,
            validatedAt: Date.now()
        });

        await writeFile(
            path.resolve(__dirname, mentionsFile),
            JSON.stringify(received)
        );
    } else {
        if (!failures[mention.source]) {
            failures[mention.source] = 1;
        } else {
            failures[mention.source]++;
        }

        await writeFile(
            path.resolve(__dirname, failureFile),
            JSON.stringify(failures)
        );
    }
}

setInterval(() => {
    try { validateMention() } catch { }
}, 500);