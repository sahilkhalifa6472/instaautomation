// Instagram API. IGAA... tokens (Instagram Login) use graph.instagram.com, EAA... tokens (Unified login) use graph.facebook.com.
const IG = "https://graph.instagram.com/v23.0";
const FB = "https://graph.facebook.com/v23.0";
const B = (token: string) => (token.startsWith("EAA") ? FB : IG);
export const SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
  "instagram_business_manage_insights",
];

async function http(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, { ...opts, cache: "no-store" });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === "string" ? body : JSON.stringify(body.error || body);
    throw new Error(`${res.status} ${url.split("?")[0].replace(IG, "").replace(FB, "")}: ${msg.slice(0, 400)}`);
  }
  return body;
}
const form = (o: Record<string, unknown>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]));
const tq = (t: string) => `access_token=${encodeURIComponent(t)}`;
const json = (o: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

// ---- login ("Continue with Instagram")
// Newer Meta apps only get "Unified login": facebook.com/dialog/oauth with a config_id (IG_CONFIG_ID),
// giving a never-expiring EAA system-user token used on graph.facebook.com. Old apps: Instagram Login.
export function authorizeUrl(appId: string, redirect: string, state: string, configId?: string) {
  if (configId) {
    const q = new URLSearchParams({ client_id: appId, config_id: configId, override_default_response_type: "true", redirect_uri: redirect, response_type: "code", state });
    return `https://www.facebook.com/v23.0/dialog/oauth?${q}`;
  }
  const q = new URLSearchParams({ enable_fb_login: "0", force_authentication: "1", client_id: appId, redirect_uri: redirect, response_type: "code", scope: SCOPES.join(","), state });
  return `https://www.instagram.com/oauth/authorize?${q}`;
}
export async function exchangeCode(appId: string, secret: string, redirect: string, code: string, unified = false) {
  if (unified) {
    const q = new URLSearchParams({ client_id: appId, client_secret: secret, redirect_uri: redirect, code });
    return (await http(`${FB}/oauth/access_token?${q}`)).access_token as string;
  }
  const short = await http("https://api.instagram.com/oauth/access_token", {
    method: "POST", body: form({ client_id: appId, client_secret: secret, grant_type: "authorization_code", redirect_uri: redirect, code: code.replace(/#_$/, "") }),
  });
  const long = await http(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(secret)}&${tq(short.access_token)}`);
  return long.access_token as string;
}
export const neverExpires = (token: string) => token.startsWith("EAA");
export async function refreshToken(token: string): Promise<string> {
  if (neverExpires(token)) return token;
  return (await http(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&${tq(token)}`)).access_token;
}
type Prof = { user_id: string; username: string; followers_count?: number; media_count?: number };
export async function me(token: string): Promise<Prof> {
  return (await accounts(token))[0];
}
// every Instagram account this token can use
export async function accounts(token: string, appId?: string, secret?: string): Promise<Prof[]> {
  if (!token.startsWith("EAA")) return [await http(`${IG}/me?fields=user_id,username,followers_count,media_count&${tq(token)}`)];
  const f = "id,username,followers_count,media_count";
  const ids = new Set<string>();
  if (appId && secret) {
    try {
      const d = await http(`${FB}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appId + "|" + secret)}`);
      for (const g of d.data?.granular_scopes || []) if (String(g.scope).startsWith("instagram")) for (const t of g.target_ids || []) ids.add(String(t));
    } catch { /* fall back to pages below */ }
  }
  try {
    const pages = await http(`${FB}/me/accounts?fields=instagram_business_account&limit=50&${tq(token)}`);
    for (const p of pages.data || []) if (p.instagram_business_account?.id) ids.add(String(p.instagram_business_account.id));
  } catch { /* token may have no pages */ }
  const out: Prof[] = [];
  for (const id of ids) {
    try { const p = await http(`${FB}/${id}?fields=${f}&${tq(token)}`); if (p.username) out.push({ ...p, user_id: String(p.id) }); } catch { /* not an IG account */ }
  }
  if (!out.length) throw new Error("Is login me koi Instagram account nahi mila. Login ke time Instagram account select karo.");
  return out;
}
// turn on webhooks (comments + DMs) for this account
export async function subscribe(userId: string, token: string) {
  return http(`${B(token)}/${userId}/subscribed_apps?subscribed_fields=comments,messages&${tq(token)}`, { method: "POST" });
}

// ---- posting (reels)
export async function createReel(userId: string, token: string, p: { video_url: string; caption: string }) {
  return http(`${B(token)}/${userId}/media`, { method: "POST", body: form({ media_type: "REELS", video_url: p.video_url, caption: p.caption, share_to_feed: "true", access_token: token }) }) as Promise<{ id: string }>;
}
export async function containerStatus(id: string, token: string) {
  return http(`${B(token)}/${id}?fields=status_code,status&${tq(token)}`) as Promise<{ status_code: string; status?: string }>;
}
export async function publish(userId: string, token: string, creationId: string) {
  return http(`${B(token)}/${userId}/media_publish`, { method: "POST", body: form({ creation_id: creationId, access_token: token }) }) as Promise<{ id: string }>;
}
export async function permalink(mediaId: string, token: string): Promise<string> {
  try { return (await http(`${B(token)}/${mediaId}?fields=permalink&${tq(token)}`)).permalink || ""; } catch { return ""; }
}

// ---- insights
export type IgMedia = { id: string; caption?: string; timestamp: string; permalink?: string; comments_count?: number; like_count?: number; media_product_type?: string; thumbnail_url?: string; media_url?: string };
export async function listMedia(userId: string, token: string, limit = 12): Promise<IgMedia[]> {
  const f = "id,caption,timestamp,permalink,comments_count,like_count,media_product_type,thumbnail_url,media_url";
  return (await http(`${B(token)}/${userId}/media?fields=${f}&limit=${limit}&${tq(token)}`)).data || [];
}
export async function mediaInsights(mediaId: string, token: string) {
  const out: Record<string, number> = {};
  try {
    const b = await http(`${B(token)}/${mediaId}/insights?metric=views,reach,likes,comments,shares,saved&${tq(token)}`);
    for (const m of b.data || []) out[m.name] = m.values?.[0]?.value ?? 0;
  } catch { /* old posts / photos may not have every metric */ }
  return out;
}

// ---- comments + DMs
export type IgComment = { id: string; text: string; timestamp: string; username?: string; from?: { id: string; username: string } };
export async function listComments(mediaId: string, token: string): Promise<IgComment[]> {
  return (await http(`${B(token)}/${mediaId}/comments?fields=id,text,timestamp,username,from&limit=50&${tq(token)}`)).data || [];
}
export async function replyToComment(commentId: string, token: string, message: string) {
  return http(`${B(token)}/${commentId}/replies`, { method: "POST", body: form({ message, access_token: token }) });
}
// DM to the person who wrote a comment (once per comment, within 7 days)
export async function privateReply(userId: string, token: string, commentId: string, text: string) {
  return http(`${B(token)}/${userId}/messages?${tq(token)}`, json({ recipient: { comment_id: commentId }, message: { text } }));
}
// same, with the link in a button card (Instagram blocks some raw links in text)
export async function privateReplyCard(userId: string, token: string, commentId: string, p: { title: string; url: string; button: string }) {
  const el = { title: p.title.slice(0, 80), buttons: [{ type: "web_url", url: p.url, title: p.button.slice(0, 20) }] };
  return http(`${B(token)}/${userId}/messages?${tq(token)}`, json({ recipient: { comment_id: commentId }, message: { attachment: { type: "template", payload: { template_type: "generic", elements: [el] } } } }));
}
export async function sendDM(userId: string, token: string, to: string, text: string) {
  return http(`${B(token)}/${userId}/messages?${tq(token)}`, json({ recipient: { id: to }, message: { text } }));
}
export type IgMsg = { id: string; message?: string; created_time: string; from?: { id: string; username?: string } };
export type IgConvo = { id: string; updated_time: string; participants?: { data: { id: string; username?: string }[] }; messages?: { data: IgMsg[] } };
export async function conversations(userId: string, token: string, limit = 20): Promise<IgConvo[]> {
  const f = encodeURIComponent("id,updated_time,participants,messages.limit(1){id,message,created_time,from}");
  return (await http(`${B(token)}/${userId}/conversations?platform=instagram&fields=${f}&limit=${limit}&${tq(token)}`)).data || [];
}
// latest messages with one person, newest first
export async function convoWith(userId: string, token: string, igsid: string, n = 20): Promise<IgMsg[]> {
  const f = encodeURIComponent(`messages.limit(${n}){id,message,created_time,from}`);
  const b = await http(`${B(token)}/${userId}/conversations?platform=instagram&user_id=${igsid}&fields=${f}&${tq(token)}`);
  return b.data?.[0]?.messages?.data || [];
}
export async function userName(igsid: string, token: string): Promise<string | undefined> {
  try { return (await http(`${B(token)}/${igsid}?fields=username&${tq(token)}`)).username; } catch { return undefined; }
}
