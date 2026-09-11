/**
 * Same-origin proxy to the TEE service.
 *
 * The TEE runs on EigenCompute at a plain-http address, which a page served over https cannot call
 * (mixed content). The browser calls /api/tee/<path> instead and this route forwards the request to
 * TEE_URL (server-only env; NEXT_PUBLIC_TEE_URL as a fallback for local runs).
 *
 * The proxy is NOT trusted for integrity: the browser still checks every document against its on-chain
 * hash (reports, blobs, ciphertext, wrapper, wrapped key, findings) and every signature. It only moves
 * bytes. Only the TEE API paths the web app uses are forwarded.
 */
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type Rule = { re: RegExp; methods: string[]; cache: "immutable" | "short" | "none"; maxBody?: number };

const KB = 1024;
const RULES: Rule[] = [
  { re: /^health$/, methods: ["GET"], cache: "short" },
  { re: /^attestation$/, methods: ["GET"], cache: "short" },
  { re: /^protocol$/, methods: ["GET"], cache: "short" },
  { re: /^reports\/\d{1,30}$/, methods: ["GET"], cache: "none" },
  { re: /^blobs\/(0x)?[0-9a-fA-F]{64}$/, methods: ["GET"], cache: "immutable" },
  { re: /^blobs$/, methods: ["PUT"], cache: "none", maxBody: 64 * KB }, // rating comments
  { re: /^deliveries\/\d{1,30}$/, methods: ["GET"], cache: "none" },
  { re: /^findings\/\d{1,30}$/, methods: ["GET"], cache: "none" },
  { re: /^evidence-upload$/, methods: ["POST"], cache: "none", maxBody: 400 * KB }, // TEE caps evidence at 256 KiB (base64 inflates)
  { re: /^evidence\/\d{1,30}$/, methods: ["POST"], cache: "none", maxBody: 16 * KB }, // juror case-packet challenge
  { re: /^preview\/quote\/\d{1,30}$/, methods: ["GET"], cache: "none" },
  { re: /^preview\/\d{1,30}$/, methods: ["POST"], cache: "none", maxBody: 1 * KB }, // ?async=1 start
];
const PASS_QUERY = new Set(["async", "refresh"]);
const TIMEOUT_MS = 55_000;

function upstream(): string | null {
  const u = (process.env.TEE_URL || process.env.NEXT_PUBLIC_TEE_URL || "").replace(/\/+$/, "");
  return /^https?:\/\//.test(u) ? u : null;
}

const json = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

async function handle(req: NextRequest, ctx: RouteContext<"/api/tee/[...path]">): Promise<Response> {
  const { path } = await ctx.params;
  const p = path.join("/");
  const rule = RULES.find((r) => r.re.test(p));
  if (!rule) return json(404, `not a proxied TEE path: /${p}`);
  if (!rule.methods.includes(req.method)) return json(405, `${req.method} not allowed on /${p}`);
  const base = upstream();
  if (!base) return json(503, "TEE service is not configured on this deployment (set TEE_URL)");

  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const max = rule.maxBody ?? 0;
    if (Number(req.headers.get("content-length") ?? 0) > max) return json(413, "request body too large");
    body = await req.arrayBuffer();
    if (body.byteLength > max) return json(413, "request body too large");
  }
  const q = new URLSearchParams();
  for (const [k, v] of req.nextUrl.searchParams) if (PASS_QUERY.has(k)) q.set(k, v);
  const qs = q.toString() ? `?${q}` : "";

  let res: Response;
  try {
    const headers: Record<string, string> = { accept: req.headers.get("accept") ?? "*/*" };
    const ct = req.headers.get("content-type");
    if (ct) headers["content-type"] = ct;
    res = await fetch(`${base}/${p}${qs}`, { method: req.method, headers, body, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return json(502, `TEE service unreachable: ${(e as Error).message}`);
  }

  const out = new Headers();
  for (const h of ["content-type", "content-length", "x-sha256"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set(
    "cache-control",
    rule.cache === "immutable" && res.ok ? "public, max-age=31536000, immutable" : rule.cache === "short" && res.ok ? "public, max-age=15" : "no-store",
  );
  return new Response(res.body, { status: res.status, headers: out });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
