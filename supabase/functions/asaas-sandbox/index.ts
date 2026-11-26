const site = "https://colanessa.pages.dev";
const db = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const checkoutId = /^[\w-]{8,100}$/;
const table = "/rest/v1/asaas_sandbox_conexoes";
const headers = {
  "Access-Control-Allow-Origin": site,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

async function database(path: string, init: RequestInit = {}) {
  const response = await fetch(db + path, {
    ...init,
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error("Banco indisponível.");
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

const eventos = new Map([
  ["CHECKOUT_PAID", "pago"],
  ["CHECKOUT_CANCELED", "cancelado"],
  ["CHECKOUT_EXPIRED", "expirado"],
]);

async function webhook(req: Request) {
  const secret = Deno.env.get("ASAAS_SANDBOX_WEBHOOK_TOKEN");
  if (!secret || req.headers.get("asaas-access-token") !== secret) return new Response(null, { status: 401 });
  const body = await req.json();
  const id = body.checkout?.id;
  const estado = eventos.get(body.event);
  if (!estado || typeof id !== "string" || !checkoutId.test(id)) return new Response(null, { status: 204 });
  await database(table + "?checkout_id=eq." + id + "&checkout_estado=eq.aguardando", {
    method: "PATCH", body: JSON.stringify({ checkout_estado: estado }),
  });
  return new Response(null, { status: 204 });
}

Deno.serve(async (req) => {
  const reply = (data: object, status = 200) => Response.json(data, { status, headers });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply({ erro: "Método inválido." }, 405);
  try {
    if (new URL(req.url).pathname.endsWith("/webhook")) return await webhook(req);
    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return reply({ erro: "Entre no Colanessa." }, 401);
    const auth = await fetch(db + "/auth/v1/user", {
      headers: { authorization, apikey: anonKey }, signal: AbortSignal.timeout(5000),
    });
    if (!auth.ok) return reply({ erro: "Entre no Colanessa." }, 401);
    const user = await auth.json();
    if (user.is_anonymous || !uuid.test(user.id)) return reply({ erro: "Entre no Colanessa." }, 401);
    const body = await req.json().catch(() => null);
    const org = body?.organizacao;
    if (typeof org !== "string" || !uuid.test(org)) return reply({ erro: "Organização inválida." }, 400);
    const [owner] = await database("/rest/v1/organizacoes?select=id&id=eq." + org + "&criado_por=eq." + user.id + "&status=eq.ativa");
    if (!owner) return reply({ erro: "Apenas a pessoa responsável pelo evento pode gerenciar essa conexão." }, 403);
    const filter = "?organizacao_id=eq." + org;
    const [row] = await database(table + filter);
    const key = Deno.env.get("ASAAS_SANDBOX_API_KEY");
    if (body.acao === "status") return reply({ configurado: !!key, carteira: row?.wallet_id ?? null, checkout: row?.checkout_id ?? null, estado: row?.checkout_estado ?? null });
    if (body.acao === "salvar") {
      const wallet = body.carteira?.trim?.();
      if (typeof wallet !== "string" || !uuid.test(wallet)) return reply({ erro: "Informe um Wallet ID de sandbox válido." }, 400);
      if (row?.wallet_id !== wallet.toLowerCase()) {
        await database(table + "?on_conflict=organizacao_id", {
          method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({ organizacao_id: org, wallet_id: wallet, checkout_id: null, checkout_estado: null, tentativa: null }),
        });
      }
      return reply({ salvo: true });
    }
    if (body.acao !== "checkout") return reply({ erro: "Ação inválida." }, 400);
    if (!row || !key) return reply({ erro: "Configure a credencial da plataforma e a carteira de teste." }, 409);
    if (row.checkout_id && row.checkout_estado === "aguardando") return reply({ checkout: row.checkout_id });
    if (row.checkout_estado === "pago") return reply({ erro: "O pagamento deste teste já foi confirmado." }, 409);
    const attempt = crypto.randomUUID();
    const [claimed] = await database(table + filter + "&wallet_id=eq." + row.wallet_id + (row.checkout_id ? "&checkout_id=eq." + row.checkout_id + "&checkout_estado=eq." + row.checkout_estado : "&tentativa=is.null"), {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ tentativa: attempt, checkout_id: null, checkout_estado: null }),
    });
    if (!claimed) return reply({ erro: "Já existe uma tentativa para essa carteira." }, 409);
    const response = await fetch("https://api-sandbox.asaas.com/v3/checkouts", {
      method: "POST",
      headers: { access_token: key, "Content-Type": "application/json", "User-Agent": "Colanessa" },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        billingTypes: ["CREDIT_CARD"], chargeTypes: ["DETACHED"], minutesToExpire: 60,
        callback: { successUrl: site + "/?asaas=concluido", cancelUrl: site + "/?asaas=cancelado", expiredUrl: site + "/?asaas=expirado" },
        items: [{ name: "Inscrição simulada Colanessa", quantity: 1, value: 10 }],
        splits: [{ walletId: claimed.wallet_id, percentualValue: 90 }],
      }),
    });
    if (!response.ok) {
      if (response.status < 500) await database(table + filter + "&tentativa=eq." + attempt, {
        method: "PATCH", body: JSON.stringify({ tentativa: null }),
      });
      const payload = await response.json().catch(() => null);
      const errors = Array.isArray(payload?.errors) ? payload.errors.slice(0, 3) : [];
      const details = errors.flatMap((item: { code?: unknown; description?: unknown }) => {
        if (!item || typeof item.code !== "string" || !/^[a-zA-Z0-9_.-]{1,80}$/.test(item.code)) return [];
        const description = typeof item.description === "string"
          ? item.description.replaceAll(key, "[oculto]").replace(/[\r\n]+/g, " ").trim().slice(0, 240)
          : "";
        return [description ? item.code + ": " + description : item.code];
      });
      return reply({
        erro: "O Asaas recusou o checkout de teste (HTTP " + response.status + ")." +
          (details.length ? " " + details.join(" · ") : ""),
      }, 502);
    }
    const checkout = await response.json();
    if (typeof checkout.id !== "string" || !checkoutId.test(checkout.id)) throw new Error("Checkout inválido.");
    const [saved] = await database(table + filter + "&tentativa=eq." + attempt, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ checkout_id: checkout.id, checkout_estado: "aguardando" }),
    });
    if (!saved) return reply({ erro: "A configuração da carteira mudou durante o teste." }, 409);
    return reply({ checkout: checkout.id });
  } catch {
    return reply({ erro: "Falha ao consultar a integração Asaas de teste." }, 502);
  }
});
