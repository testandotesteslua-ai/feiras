const origin = "https://testandotesteslua-ai.github.io";
const headers = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};
const api = "https://api.mercadopago.com";
const testSellerId = 3870233502;
const reference = "colanessa-checkout-teste";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const testOrderId = /^ORDTST[A-Z0-9]{10,40}$/;

function reply(data: object, status = 200) {
  return Response.json(data, { status, headers });
}

async function isAdmin(req: Request) {
  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const url = Deno.env.get("SUPABASE_URL");
  const apikey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const options = { headers: { authorization, apikey }, signal: AbortSignal.timeout(5000) };
  const session = await fetch(`${url}/auth/v1/user`, options);
  if (!session.ok) return false;
  const user = await session.json();
  if (!user.id || user.is_anonymous) return false;
  const profile = await fetch(
    `${url}/rest/v1/perfis?select=eh_admin&id=eq.${encodeURIComponent(user.id)}`,
    options,
  );
  if (!profile.ok) return false;
  const rows = await profile.json();
  return rows[0]?.eh_admin === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply({ erro: "Método inválido." }, 405);
  try {
    if (!await isAdmin(req)) return reply({ erro: "Acesso restrito à administração." }, 403);
    const body = await req.json().catch(() => null);
    const creating = body?.acao === "criar" && typeof body.tentativa === "string" && uuid.test(body.tentativa);
    const checking = body?.acao === "consultar" && typeof body.id === "string" && testOrderId.test(body.id);
    if (!creating && !checking) return reply({ erro: "Dados do teste inválidos." }, 400);

    const token = Deno.env.get("MERCADO_PAGO_TEST_ACCESS_TOKEN");
    if (!token) return reply({ erro: "Credencial de teste ausente no Supabase." }, 503);
    const authorization = { Authorization: `Bearer ${token}` };
    if (creating) {
      const account = await fetch(`${api}/users/me`, {
        headers: authorization,
        signal: AbortSignal.timeout(8000),
      });
      const user = await account.json().catch(() => null);
      if (!account.ok || Number(user?.id) !== testSellerId) {
        return reply({ erro: "O Mercado Pago não confirmou a conta de teste da aplicação.", codigo: account.status }, 502);
      }
    }

    const response = await fetch(creating ? `${api}/v1/orders` : `${api}/v1/orders/${body.id}`, {
      method: creating ? "POST" : "GET",
      headers: { ...authorization, ...(creating && {
        "Content-Type": "application/json",
        "X-Idempotency-Key": body.tentativa,
      }) },
      signal: AbortSignal.timeout(12000),
      ...(creating && { body: JSON.stringify({
        type: "online",
        processing_mode: "manual",
        total_amount: "10.00",
        external_reference: reference,
        items: [{ title: "Teste Cola Nessa", unit_price: "10.00", quantity: 1 }],
      }) }),
    });
    const order = await response.json().catch(() => null);
    if (!response.ok || !testOrderId.test(order?.id ?? "")) {
      return reply({ erro: "O Mercado Pago não retornou uma cobrança de teste.", codigo: response.status,
        detalhes: Array.isArray(order?.errors) ? order.errors.map((e: { code?: string }) => e.code).filter(Boolean) : [] }, 502);
    }
    if (order.external_reference !== reference) return reply({ erro: "Cobrança fora do teste do Cola Nessa." }, 404);
    const data = { id: order.id, status: order.status, detalhe: order.status_detail };
    if (!creating) return reply(data);
    const checkout = new URL(order.checkout_url);
    if (checkout.protocol !== "https:" || checkout.hostname !== "www.mercadopago.com.br") {
      return reply({ erro: "Endereço do checkout de teste inválido." }, 502);
    }
    return reply({ ...data, checkout: checkout.href });
  } catch {
    return reply({ erro: "Não foi possível completar o teste. Tente novamente." }, 502);
  }
});
