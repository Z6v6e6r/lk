#!/usr/bin/env node
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

function printUsage() {
  const usage = `
Usage:
  node scripts/fcm/send-fcm.mjs --service-account ./service-account.json --token <FCM_TOKEN> [options]
  node scripts/fcm/send-fcm.mjs --service-account ./service-account.json --topic <TOPIC> [options]

Required:
  --service-account <path>   Path to Firebase service account JSON
  --token <value>            FCM token of a specific device
    or
  --topic <value>            FCM topic (without /topics/)

Optional:
  --project-id <value>       Firebase project id (defaults to service account project_id)
  --title <value>            Notification title
  --body <value>             Notification body
  --data <key=value>         Custom data pair, can be repeated
  --android-channel-id <id>  Android channel id (default: lk_default)
  --dry-run                  Validate message without delivery
  --help                     Show this help

Examples:
  node scripts/fcm/send-fcm.mjs \\
    --service-account ./secrets/firebase-service-account.json \\
    --token eF2... \\
    --title "Тест" \\
    --body "Проверка доставки"

  node scripts/fcm/send-fcm.mjs \\
    --service-account ./secrets/firebase-service-account.json \\
    --token eF2... \\
    --data deepLink=/lk_new\\?openGameId\\=123 \\
    --data type=game_invite
`;
  console.log(usage.trim());
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseArgs(argv) {
  const args = {
    serviceAccountPath: "",
    projectId: "",
    token: "",
    topic: "",
    title: "",
    body: "",
    androidChannelId: "lk_default",
    dryRun: false,
    data: {},
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }
    if (current === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (current === "--service-account" && next) {
      args.serviceAccountPath = String(next);
      index += 1;
      continue;
    }
    if (current === "--project-id" && next) {
      args.projectId = String(next);
      index += 1;
      continue;
    }
    if (current === "--token" && next) {
      args.token = String(next);
      index += 1;
      continue;
    }
    if (current === "--topic" && next) {
      args.topic = String(next);
      index += 1;
      continue;
    }
    if (current === "--title" && next) {
      args.title = String(next);
      index += 1;
      continue;
    }
    if (current === "--body" && next) {
      args.body = String(next);
      index += 1;
      continue;
    }
    if (current === "--android-channel-id" && next) {
      args.androidChannelId = String(next);
      index += 1;
      continue;
    }
    if (current === "--data" && next) {
      const [rawKey, ...rawValueParts] = String(next).split("=");
      const key = rawKey?.trim();
      const value = rawValueParts.join("=").trim();
      if (key) {
        args.data[key] = value;
      }
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${current}`);
  }

  return args;
}

async function loadServiceAccount(pathToFile) {
  const fileRaw = await readFile(pathToFile, "utf-8");
  const parsed = JSON.parse(fileRaw);
  const clientEmail = String(parsed.client_email || "").trim();
  const privateKey = String(parsed.private_key || "").trim();
  const projectId = String(parsed.project_id || "").trim();

  if (!clientEmail || !privateKey) {
    throw new Error("Service account JSON must include client_email and private_key");
  }

  return {
    clientEmail,
    privateKey,
    projectId,
  };
}

function createGoogleJwt(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    aud: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();
  const signatureBase64 = signer.sign(privateKey, "base64");
  const signature = signatureBase64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  return `${unsignedToken}.${signature}`;
}

async function fetchAccessToken(jwtAssertion) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwtAssertion,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(`Failed to get Google access token: HTTP ${response.status} ${JSON.stringify(payload)}`);
  }

  return String(payload.access_token);
}

function dropUndefined(input) {
  if (Array.isArray(input)) {
    return input.map((value) => dropUndefined(value));
  }
  if (!input || typeof input !== "object") {
    return input;
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    cleaned[key] = dropUndefined(value);
  }
  return cleaned;
}

async function sendFcmMessage({ accessToken, projectId, token, topic, title, body, data, channelId, dryRun }) {
  const message = dropUndefined({
    token: token || undefined,
    topic: topic || undefined,
    notification: title || body ? { title: title || undefined, body: body || undefined } : undefined,
    data: Object.keys(data).length > 0 ? data : undefined,
    android: {
      priority: "high",
      notification: {
        channel_id: channelId || undefined,
      },
    },
  });

  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      validate_only: dryRun,
      message,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`FCM send failed: HTTP ${response.status} ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  if (!args.serviceAccountPath) {
    throw new Error("Missing --service-account");
  }
  if (!args.token && !args.topic) {
    throw new Error("Pass either --token or --topic");
  }
  if (args.token && args.topic) {
    throw new Error("Use only one recipient: --token or --topic");
  }

  const serviceAccount = await loadServiceAccount(args.serviceAccountPath);
  const projectId = String(args.projectId || serviceAccount.projectId).trim();
  if (!projectId) {
    throw new Error("Missing Firebase project id. Pass --project-id or ensure project_id exists in service account JSON");
  }

  const jwt = createGoogleJwt(serviceAccount.clientEmail, serviceAccount.privateKey);
  const accessToken = await fetchAccessToken(jwt);
  const responsePayload = await sendFcmMessage({
    accessToken,
    projectId,
    token: args.token,
    topic: args.topic,
    title: args.title,
    body: args.body,
    data: args.data,
    channelId: args.androidChannelId,
    dryRun: args.dryRun,
  });

  console.log("FCM response:");
  console.log(JSON.stringify(responsePayload, null, 2));
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
