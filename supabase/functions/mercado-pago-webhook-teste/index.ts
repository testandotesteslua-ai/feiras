const encoder = new TextEncoder();
const secret = Deno.env.get("MERCADO_PAGO_WEBHOOK_TEST_SECRET");
const sandboxOrder = /^ORDTST[A-Z0-9]{10,40}$/i;

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  if (!secret) return new Response("Webhook de teste aguardando configuração.", { status: 503 });

  const url = new URL(request.url);
  const ids = url.searchParams.getAll("data.id");
  const id = ids[0] ?? "";
  const requestId = request.headers.get("x-request-id") ?? "";
  const signature = request.headers.get("x-signature") ?? "";
  if (ids.length !== 1 || !/^[a-z0-9]{1,80}$/i.test(id) ||
      !/^[a-z0-9_-]{1,128}$/i.test(requestId) || signature.length > 512) {
    return new Response(null, { status: 401 });
  }

  const fields = signature.split(",").map((part) => part.trim());
  const timestamps = fields.filter((part) => part.startsWith("ts="));
  const hashes = fields.filter((part) => part.startsWith("v1="));
  const ts = timestamps[0]?.slice(3) ?? "";
  const hash = hashes[0]?.slice(3) ?? "";
  if (timestamps.length !== 1 || hashes.length !== 1 || !/^\d{10,13}$/.test(ts) ||
      !/^[a-f0-9]{64}$/i.test(hash)) {
    return new Response(null, { status: 401 });
  }

  const key = await crypto.subtle.importKey("raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signatureBytes = Uint8Array.from(hash.match(/../g)!, (byte) => parseInt(byte, 16));
  const canonicalIds = new Set([id, id.toLowerCase()]);
  const matches = await Promise.all([...canonicalIds].map((value) => crypto.subtle.verify(
    "HMAC", key, signatureBytes, encoder.encode(`id:${value};request-id:${requestId};ts:${ts};`),
  )));
  if (!matches.includes(true)) return new Response(null, { status: 401 });

  // The signed URL identifies the order. Payload fields never change payment state.
  if (sandboxOrder.test(id)) {
    console.info("Webhook de teste de Orders recebido", { order_id: id.toUpperCase() });
  }
  return new Response(null, { status: 200 });
});
