#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_WEBSITE_URL = "https://www.joinvantage.live/";
const DEFAULT_DOWNLOAD_URL = "https://www.joinvantage.live/download#download-options";
const DEFAULT_MANAGE_URL = "https://www.joinvantage.live/manage-license";
const DEFAULT_LOGO_URL = "https://www.joinvantage.live/assets/images/logo.png";
const DEFAULT_UPDATER_IMAGE_PATH = path.join(process.cwd(), "docs/ops/assets/vantage-software-updates-discord.png");
const DEFAULT_PROP_FIRM_FINDER_IMAGE_PATH = path.join(process.cwd(), "docs/ops/assets/vantage-prop-firm-finder-board-discord.png");
const DEFAULT_PROP_FIRM_PLAN_IMAGE_PATH = path.join(process.cwd(), "docs/ops/assets/vantage-prop-firm-plan-screener-discord.png");
const DEFAULT_PROP_FIRM_APP_IMAGE_URL = "https://www.joinvantage.live/assets/images/screenshots/prop-firms.png";
const DEFAULT_PROP_FIRM_APP_IMAGE_PATH = path.join(process.cwd(), "TradeTracker-Website/assets/images/screenshots/prop-firms.png");
const DEFAULT_CHARTS_IMAGE_URL = "https://www.joinvantage.live/assets/images/screenshots/charts.png";
const DEFAULT_CHARTS_IMAGE_PATH = path.join(process.cwd(), "TradeTracker-Website/assets/images/screenshots/charts.png");
const DEFAULT_RECOVERY_IMAGE_PATH = path.join(process.cwd(), "docs/ops/assets/vantage-recovery-backups-discord.png");
const DISCORD_GOLD = 0xf1d65a;

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function argValue(argv, name) {
  const exact = argv.indexOf(name);
  if (exact !== -1) return argv[exact + 1] || "";
  const prefix = `${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

function limit(text, max) {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fallbackTag(env) {
  try {
    const pkg = readJsonFile(path.join(process.cwd(), "package.json"));
    if (pkg?.version) return `v${pkg.version}`;
  } catch {
    // Ignore package fallback failures.
  }
  return env.GITHUB_REF_NAME || "latest";
}

function releaseUrlFor(tag, env, release = {}) {
  if (env.DISCORD_RELEASE_URL) return env.DISCORD_RELEASE_URL;
  if (release.html_url) return release.html_url;
  const repo = env.GITHUB_REPOSITORY || "POOGLE90/TradeTracker-Releases";
  return `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;
}

function normalizeRelease({ env = process.env, event = null } = {}) {
  const eventRelease = event?.release || {};
  const tag = env.DISCORD_RELEASE_TAG || eventRelease.tag_name || fallbackTag(env);
  const title = env.DISCORD_RELEASE_TITLE || eventRelease.name || `Vantage ${tag}`;
  const body = env.DISCORD_RELEASE_BODY || eventRelease.body || "";

  return {
    tag,
    title,
    body,
    url: releaseUrlFor(tag, env, eventRelease),
    draft: bool(env.DISCORD_RELEASE_DRAFT, Boolean(eventRelease.draft)),
    prerelease: bool(env.DISCORD_RELEASE_PRERELEASE, Boolean(eventRelease.prerelease)),
    publishedAt: eventRelease.published_at || env.DISCORD_RELEASE_PUBLISHED_AT || new Date().toISOString(),
    assets: Array.isArray(eventRelease.assets) ? eventRelease.assets : [],
  };
}

export function releaseShouldPost(release, env = process.env) {
  if (release.draft) {
    return { ok: false, reason: "release is still draft" };
  }
  if (release.prerelease && !bool(env.DISCORD_POST_PRERELEASES, false)) {
    return { ok: false, reason: "release is marked prerelease and DISCORD_POST_PRERELEASES is not true" };
  }
  return { ok: true, reason: "official release publish" };
}

function cleanReleaseBody(body) {
  return String(body || "")
    .replace(/\\n/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractPublicReleaseLines(body) {
  const ignored = /^(#+\s*)?(download|downloads|installer|installers|assets|checksums?|full changelog|release notes|what'?s new|what'?s inside|highlights?|update from inside vantage|manual download|local-first reminder)\b/i;
  const internalOrSensitive = /\b(api key|secret|token|password|credential|webhook|github action|cloudflare worker|durable object|d1\b|kv\b|sidecar|public-build|public build|native parity|ipc|stack trace|traceback|smoke test|test passed|ops dashboard|command center|owner key|private customer|customer data|notarization credential|developer id|keychain item)\b|\/Users\/|\/private\/|\.env\b/i;
  return cleanReleaseBody(body)
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^#+\s*/, "").trim())
    .filter((line) => !ignored.test(line))
    .filter((line) => !internalOrSensitive.test(line))
    .filter((line) => !/^vantage desktop v?\d+\.\d+\.\d+$/i.test(line))
    .filter((line) => !/^https?:\/\/\S+$/i.test(line))
    .filter(Boolean);
}

function extractHighlights(body) {
  const rawLines = extractPublicReleaseLines(body);

  const highlights = rawLines.slice(0, 10).map((line) => `- ${limit(line, 210)}`);
  if (highlights.length) return highlights;

  return [
    "- The newest Vantage desktop update is available from the official release channel.",
    "- Open Vantage when you are ready, or download the latest installer from the release page.",
    "- Your journal, screenshots, broker imports, and money workspace stay local on your device.",
  ];
}

function detailLinesFor(lines, patterns, fallback) {
  const found = [];
  for (const pattern of patterns) {
    const line = lines.find((candidate) => pattern.test(candidate));
    if (line && !found.includes(line)) found.push(line);
  }
  if (!found.length) return limit(fallback, 1200);
  if (found.length === 1) return limit(found[0], 1200);
  return limit(found.map((line) => `- ${line}`).join("\n"), 1200);
}

function compactHighlights(lines, fallbackBullets) {
  const groups = [
    {
      label: "Prop Firm Mode inside Vantage",
      patterns: [/prop firm mode/i],
    },
    {
      label: "New Chart System",
      patterns: [/chart system/i],
    },
    {
      label: "Recovery Backups",
      patterns: [/recovery backups?/i],
    },
    {
      label: "Plan Screener",
      patterns: [/plan screener/i],
    },
    {
      label: "Firm Scanner",
      patterns: [/firm scanner/i],
    },
    {
      label: "Replay, trade planning, and chart polish",
      patterns: [/replay charts/i, /replay and forward/i, /trade planning/i, /chart reliability/i, /auto sl\/tp/i, /symbol search/i, /crypto replay/i],
    },
  ];

  const compact = groups
    .filter((group) => group.patterns.some((pattern) => lines.some((line) => pattern.test(line))))
    .map((group) => `- ${group.label}`);

  if (compact.length >= 3) return compact.join("\n");
  return fallbackBullets.slice(0, 8).join("\n");
}

function assetSummary(release) {
  const names = release.assets.map((asset) => asset?.name).filter(Boolean);
  const mac = names.some((name) => /mac|dmg/i.test(name));
  const win = names.some((name) => /win|setup|\.exe$/i.test(name));
  if (mac && win) return "Mac and Windows installers are attached to the release.";
  if (mac) return "Mac installers are attached to the release.";
  if (win) return "Windows installer is attached to the release.";
  return "Installers are available from the official release page.";
}

function updateInstructions(downloadUrl) {
  return [
    `Already have Vantage? Open Vantage -> Settings -> App & Files -> Software Updates, then click Check for Updates.`,
    `New install or manual update? Use the official Vantage download page: ${downloadUrl}`,
  ].join("\n");
}

export function buildDiscordPayload(release, options = {}) {
  const websiteUrl = options.websiteUrl || DEFAULT_WEBSITE_URL;
  const downloadUrl = options.downloadUrl || DEFAULT_DOWNLOAD_URL;
  const manageUrl = options.manageUrl || DEFAULT_MANAGE_URL;
  const logoUrl = options.logoUrl || DEFAULT_LOGO_URL;
  const mentionEveryone = options.mentionEveryone !== false;
  const updaterImageUrl = options.updaterImageUrl || "";
  const updaterImageAttachmentName = options.updaterImageAttachmentName || "";
  const propFirmFinderImageUrl = options.propFirmFinderImageUrl || "";
  const propFirmFinderImageAttachmentName = options.propFirmFinderImageAttachmentName || "";
  const propFirmPlanImageUrl = options.propFirmPlanImageUrl || "";
  const propFirmPlanImageAttachmentName = options.propFirmPlanImageAttachmentName || "";
  const propFirmAppImageUrl = options.propFirmAppImageUrl || "";
  const propFirmAppImageAttachmentName = options.propFirmAppImageAttachmentName || "";
  const chartsImageUrl = options.chartsImageUrl || "";
  const chartsImageAttachmentName = options.chartsImageAttachmentName || "";
  const recoveryImageUrl = options.recoveryImageUrl || "";
  const recoveryImageAttachmentName = options.recoveryImageAttachmentName || "";
  const publicReleaseLines = extractPublicReleaseLines(release.body);
  const highlightBullets = extractHighlights(release.body);
  const highlights = compactHighlights(publicReleaseLines, highlightBullets);
  const propFirmDescription = detailLinesFor(
    publicReleaseLines,
    [/prop firm mode/i],
    "A cleaner command view for prop firm traders: rules, balances, drawdown pressure, challenge status, fees, payouts, and account performance in one place.",
  );
  const chartsDescription = detailLinesFor(
    publicReleaseLines,
    [/chart system/i, /replay charts/i, /replay and forward/i, /trade planning/i, /chart reliability/i, /auto sl\/tp/i, /symbol search/i, /crypto replay/i],
    "The chart system feels cleaner and easier to trust, with smoother replay context, clearer trade markers, synced panes, and better multi-chart behavior.",
  );
  const recoveryDescription = detailLinesFor(
    publicReleaseLines,
    [/recovery backups?/i],
    "Before a reset, purge, or app recovery, users can create a local recovery backup for trades, journal notes, accounts, replay workspaces, prop firm history, screenshots, and community themes.",
  );
  const planDescription = detailLinesFor(
    publicReleaseLines,
    [/plan screener/i],
    "Compare actual plan-level rules instead of picking a firm by name alone: entry cost, drawdown, split, fees, platforms, and tracking.",
  );
  const finderDescription = detailLinesFor(
    publicReleaseLines,
    [/firm scanner/i],
    "Scan the funded-futures board by firm, platform, offer, price, and fit before choosing a challenge.",
  );
  const title = `Vantage ${release.tag} is live`;
  const content = mentionEveryone
    ? `@everyone\n**${title}.** The official desktop update is ready.`
    : `**${title}.** The official desktop update is ready.`;

  const payload = {
    username: options.username || "Vantage Updates",
    avatar_url: options.avatarUrl || logoUrl,
    content: limit(content, 1800),
    allowed_mentions: {
      parse: mentionEveryone ? ["everyone"] : [],
    },
    embeds: [
      {
        title,
        url: downloadUrl,
        color: DISCORD_GOLD,
        description: limit(`A new Vantage desktop build is now available.\n\n**What's inside**\n${highlights}\n\nDetails are paired with the screenshots below.`, 3900),
        thumbnail: {
          url: logoUrl,
        },
        fields: [
          {
            name: "Download from Vantage",
            value: limit(`[Choose your installer on the Vantage website](${downloadUrl})\n[Read release notes](${release.url})`, 1000),
            inline: false,
          },
          {
            name: "How to update",
            value: limit(updateInstructions(downloadUrl), 1000),
            inline: false,
          },
          {
            name: "Installer status",
            value: limit(`${assetSummary(release)} Use the website link above for tracked downloads.`, 1000),
            inline: false,
          },
          {
            name: "Local-first reminder",
            value: "Your trading journal, screenshots, broker imports, and money workspace stay on your device. Vantage release posts never include private customer data.",
            inline: false,
          },
          {
            name: "Need help?",
            value: limit(`Use the support channel or manage your license here: ${manageUrl}`, 1000),
            inline: false,
          },
          {
            name: "One quiet extra",
            value: "The V is not just a logo in this build. If it keeps catching your eye, give it five chances and keep it word-of-mouth.",
            inline: false,
          },
          {
            name: "Screenshots below",
            value: "Prop Firm Mode, Charts, Recovery Backups, Plan Screener, Firm Scanner, and the in-app update path.",
            inline: false,
          },
        ],
        footer: {
          text: "Vantage - local-first trading journal and money OS",
        },
        timestamp: release.publishedAt,
      },
    ],
  };

  const propFirmFinderEmbedImageUrl = propFirmFinderImageUrl || (propFirmFinderImageAttachmentName ? `attachment://${propFirmFinderImageAttachmentName}` : "");
  const propFirmPlanEmbedImageUrl = propFirmPlanImageUrl || (propFirmPlanImageAttachmentName ? `attachment://${propFirmPlanImageAttachmentName}` : "");
  const propFirmAppEmbedImageUrl = propFirmAppImageUrl || (propFirmAppImageAttachmentName ? `attachment://${propFirmAppImageAttachmentName}` : "");
  const chartsEmbedImageUrl = chartsImageUrl || (chartsImageAttachmentName ? `attachment://${chartsImageAttachmentName}` : "");
  const recoveryEmbedImageUrl = recoveryImageUrl || (recoveryImageAttachmentName ? `attachment://${recoveryImageAttachmentName}` : "");
  const updaterEmbedImageUrl = updaterImageUrl || (updaterImageAttachmentName ? `attachment://${updaterImageAttachmentName}` : "");

  if (propFirmAppEmbedImageUrl) {
    payload.embeds.push({
      title: "Prop Firm Mode Inside Vantage",
      url: `${websiteUrl.replace(/\/+$/, "")}/prop-firm-finder`,
      color: DISCORD_GOLD,
      description: propFirmDescription,
      image: {
        url: propFirmAppEmbedImageUrl,
      },
    });
  }

  if (chartsEmbedImageUrl) {
    payload.embeds.push({
      title: "New Chart System",
      url: downloadUrl,
      color: DISCORD_GOLD,
      description: chartsDescription,
      image: {
        url: chartsEmbedImageUrl,
      },
    });
  }

  if (recoveryEmbedImageUrl) {
    payload.embeds.push({
      title: "Recovery Backups",
      url: downloadUrl,
      color: DISCORD_GOLD,
      description: recoveryDescription,
      image: {
        url: recoveryEmbedImageUrl,
      },
    });
  }

  if (propFirmPlanEmbedImageUrl) {
    payload.embeds.push({
      title: "Plan Screener",
      url: `${websiteUrl.replace(/\/+$/, "")}/prop-firm-finder/app`,
      color: DISCORD_GOLD,
      description: planDescription,
      image: {
        url: propFirmPlanEmbedImageUrl,
      },
    });
  }

  if (propFirmFinderEmbedImageUrl) {
    payload.embeds.push({
      title: "Firm Scanner",
      url: `${websiteUrl.replace(/\/+$/, "")}/prop-firm-finder`,
      color: DISCORD_GOLD,
      description: finderDescription,
      image: {
        url: propFirmFinderEmbedImageUrl,
      },
    });
  }

  if (updaterEmbedImageUrl) {
    payload.embeds.push({
      title: "Update From Inside Vantage",
      url: downloadUrl,
      color: DISCORD_GOLD,
      description: "Already have Vantage installed? Open **Settings -> App & Files -> Software Updates**, then click **Check for Updates**. New installs should use the Vantage website download page.",
      image: {
        url: updaterEmbedImageUrl,
      },
    });
  }

  return payload;
}

function imageContentType(filename) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function resolveUpdaterImage(env = process.env) {
  const updaterImageUrl = env.DISCORD_RELEASE_UPDATER_IMAGE_URL || "";
  if (updaterImageUrl) return { url: updaterImageUrl };

  const updaterImagePath = env.DISCORD_RELEASE_UPDATER_IMAGE_PATH || DEFAULT_UPDATER_IMAGE_PATH;
  if (!updaterImagePath || !fs.existsSync(updaterImagePath)) return null;

  return {
    path: updaterImagePath,
    name: path.basename(updaterImagePath),
    contentType: imageContentType(updaterImagePath),
  };
}

function resolveReleaseImage(env = process.env, config = {}) {
  const imageUrl = config.urlEnv ? env[config.urlEnv] : "";
  if (imageUrl) return { url: imageUrl };

  const configuredPath = config.pathEnv ? env[config.pathEnv] : "";
  if (configuredPath && fs.existsSync(configuredPath)) {
    return {
      path: configuredPath,
      name: path.basename(configuredPath),
      contentType: imageContentType(configuredPath),
    };
  }

  if (config.defaultUrl) return { url: config.defaultUrl };

  if (config.defaultPath && fs.existsSync(config.defaultPath)) {
    return {
      path: config.defaultPath,
      name: path.basename(config.defaultPath),
      contentType: imageContentType(config.defaultPath),
    };
  }

  return null;
}

function attachmentNameFromEmbed(embed) {
  const imageUrl = String(embed?.image?.url || "");
  const match = imageUrl.match(/^attachment:\/\/(.+)$/);
  return match ? match[1] : "";
}

export function buildDiscordMessages(payload, attachments = []) {
  const embeds = Array.isArray(payload?.embeds) ? payload.embeds : [];
  if (!embeds.length) return [{ payload, attachments: [] }];

  const attachmentMap = new Map(
    attachments
      .filter((attachment) => attachment?.path && attachment?.name)
      .map((attachment) => [attachment.name, attachment]),
  );
  const basePayload = {
    username: payload.username,
    avatar_url: payload.avatar_url,
  };
  const messages = [
    {
      payload: {
        ...basePayload,
        content: payload.content,
        allowed_mentions: payload.allowed_mentions,
        embeds: [embeds[0]],
      },
      attachments: [],
    },
  ];

  for (const embed of embeds.slice(1)) {
    const attachmentName = attachmentNameFromEmbed(embed);
    const attachment = attachmentName ? attachmentMap.get(attachmentName) : null;
    messages.push({
      payload: {
        ...basePayload,
        allowed_mentions: { parse: [] },
        embeds: [embed],
      },
      attachments: attachment ? [attachment] : [],
    });
  }

  return messages;
}

async function postDiscordMessage(webhookUrl, payload, attachments = []) {
  const fileAttachments = attachments.filter((attachment) => attachment?.path);
  if (fileAttachments.length) {
    const form = new FormData();
    const payloadWithAttachments = {
      ...payload,
      attachments: fileAttachments.map((attachment, index) => ({
        id: index,
        filename: attachment.name,
        description: attachment.description || attachment.name,
      })),
    };
    form.append("payload_json", JSON.stringify(payloadWithAttachments));
    for (const [index, attachment] of fileAttachments.entries()) {
      const bytes = await fsp.readFile(attachment.path);
      form.append(
        `files[${index}]`,
        new Blob([bytes], { type: attachment.contentType || imageContentType(attachment.name) }),
        attachment.name,
      );
    }

    const response = await fetch(webhookUrl, {
      method: "POST",
      body: form,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Discord webhook failed with ${response.status}: ${limit(body, 800)}`);
    }
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Discord webhook failed with ${response.status}: ${limit(body, 800)}`);
  }
}

async function postToDiscord(webhookUrl, payload, attachments = []) {
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(String(webhookUrl || ""))) {
    throw new Error("DISCORD_RELEASE_WEBHOOK_URL is missing or is not a Discord webhook URL.");
  }

  const messages = buildDiscordMessages(payload, attachments);
  for (const message of messages) {
    await postDiscordMessage(webhookUrl, message.payload, message.attachments);
  }
}

async function writePayload(payloadPath, payload) {
  if (!payloadPath) return;
  await fsp.mkdir(path.dirname(payloadPath), { recursive: true });
  await fsp.writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const event = readJsonFile(env.GITHUB_EVENT_PATH);
  const release = normalizeRelease({ env, event });
  const dryRun = argv.includes("--dry-run") || bool(env.DISCORD_DRY_RUN, false);
  const payloadPath = argValue(argv, "--payload-out") || env.DISCORD_RELEASE_PAYLOAD_PATH || "";
  const mentionEveryone = bool(env.DISCORD_ALLOW_EVERYONE, true);
  const updaterImage = resolveUpdaterImage(env);
  const propFirmFinderImage = resolveReleaseImage(env, {
    urlEnv: "DISCORD_RELEASE_PROP_FIRM_FINDER_IMAGE_URL",
    pathEnv: "DISCORD_RELEASE_PROP_FIRM_FINDER_IMAGE_PATH",
    defaultPath: DEFAULT_PROP_FIRM_FINDER_IMAGE_PATH,
  });
  const propFirmPlanImage = resolveReleaseImage(env, {
    urlEnv: "DISCORD_RELEASE_PROP_FIRM_PLAN_IMAGE_URL",
    pathEnv: "DISCORD_RELEASE_PROP_FIRM_PLAN_IMAGE_PATH",
    defaultPath: DEFAULT_PROP_FIRM_PLAN_IMAGE_PATH,
  });
  const propFirmAppImage = resolveReleaseImage(env, {
    urlEnv: "DISCORD_RELEASE_PROP_FIRM_APP_IMAGE_URL",
    pathEnv: "DISCORD_RELEASE_PROP_FIRM_APP_IMAGE_PATH",
    defaultUrl: DEFAULT_PROP_FIRM_APP_IMAGE_URL,
    defaultPath: DEFAULT_PROP_FIRM_APP_IMAGE_PATH,
  });
  const chartsImage = resolveReleaseImage(env, {
    urlEnv: "DISCORD_RELEASE_CHARTS_IMAGE_URL",
    pathEnv: "DISCORD_RELEASE_CHARTS_IMAGE_PATH",
    defaultUrl: DEFAULT_CHARTS_IMAGE_URL,
    defaultPath: DEFAULT_CHARTS_IMAGE_PATH,
  });
  const recoveryImage = resolveReleaseImage(env, {
    urlEnv: "DISCORD_RELEASE_RECOVERY_IMAGE_URL",
    pathEnv: "DISCORD_RELEASE_RECOVERY_IMAGE_PATH",
    defaultPath: DEFAULT_RECOVERY_IMAGE_PATH,
  });
  const payload = buildDiscordPayload(release, {
    mentionEveryone,
    websiteUrl: env.VANTAGE_WEBSITE_URL || DEFAULT_WEBSITE_URL,
    downloadUrl: env.VANTAGE_DOWNLOAD_URL || DEFAULT_DOWNLOAD_URL,
    manageUrl: env.VANTAGE_MANAGE_LICENSE_URL || DEFAULT_MANAGE_URL,
    logoUrl: env.DISCORD_RELEASE_LOGO_URL || DEFAULT_LOGO_URL,
    avatarUrl: env.DISCORD_RELEASE_AVATAR_URL || "",
    username: env.DISCORD_RELEASE_USERNAME || "Vantage Updates",
    updaterImageUrl: updaterImage?.url || "",
    updaterImageAttachmentName: updaterImage?.path ? updaterImage.name : "",
    propFirmFinderImageUrl: propFirmFinderImage?.url || "",
    propFirmFinderImageAttachmentName: propFirmFinderImage?.path ? propFirmFinderImage.name : "",
    propFirmPlanImageUrl: propFirmPlanImage?.url || "",
    propFirmPlanImageAttachmentName: propFirmPlanImage?.path ? propFirmPlanImage.name : "",
    propFirmAppImageUrl: propFirmAppImage?.url || "",
    propFirmAppImageAttachmentName: propFirmAppImage?.path ? propFirmAppImage.name : "",
    chartsImageUrl: chartsImage?.url || "",
    chartsImageAttachmentName: chartsImage?.path ? chartsImage.name : "",
    recoveryImageUrl: recoveryImage?.url || "",
    recoveryImageAttachmentName: recoveryImage?.path ? recoveryImage.name : "",
  });
  await writePayload(payloadPath, payload);

  const decision = releaseShouldPost(release, env);
  if (!decision.ok) {
    console.log(`Skipping Discord release announcement: ${decision.reason}`);
    return { posted: false, skipped: true, reason: decision.reason, payload };
  }

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    console.log("Dry run enabled; Discord webhook was not called.");
    return { posted: false, dryRun: true, payload };
  }

  await postToDiscord(env.DISCORD_RELEASE_WEBHOOK_URL, payload, [
    propFirmAppImage,
    chartsImage,
    recoveryImage,
    propFirmPlanImage,
    propFirmFinderImage,
    updaterImage,
  ]);
  console.log(`Posted Discord release announcement for ${release.tag}.`);
  return { posted: true, payload };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exit(1);
  });
}
