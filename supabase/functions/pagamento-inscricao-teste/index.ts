const origin = "https://testandotesteslua-ai.github.io";
const headers = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};
const api = "https://api.mercadopago.com";
const testSellerId = 3870233502;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const testOrderId = /^ORDTST[A-Z0-9]{10,40}$/;

function reply(data: object, status = 200) {
  return Response.json(data, { status, headers });
}

const db = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const payments = "/rest/v1/pagamentos_mercado_pago_teste";

async function database(path: string, init: RequestInit = {}) {
  const response = await fetch(db + path, {
    ...init,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error("Banco indisponível");
  const payload = await response.text();
  return payload ? JSON.parse(payload) : null;
}

function amountFor(ins: any, edition: any) {
  if (ins.status !== "confirmada" || ins.isento || ins.pago || ins.pago_sinal || Number(ins.valor_pago) > 0 ||
      Number(ins.credito_usado) > 0 || ins.comprovante_path || edition.gratuita || edition.cancelada_em) return 0;
  const price = Number(ins.valor_combinado ?? (
    ins.dia_unico && edition.preco_dia != null ? edition.preco_dia :
      ({ unico: edition.preco_unico, "2m": edition.preco_2m, "3m": edition.preco_3m } as Record<string, unknown>)[ins.tamanho]
  ));
  return Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : 0;
}

function statusOf(row: any) {
  if (!row) return { estado: "inativo" };
  return {
    estado: row.confirmado_em ? "confirmado" : row.order_id ? "aguardando" : "pronto",
    valor: Number(row.valor),
    confirmado_em: row.confirmado_em,
  };
}

async function mercadoPago(path: string, init: RequestInit = {}) {
  const token = Deno.env.get("MERCADO_PAGO_TEST_ACCESS_TOKEN");
  if (!token) throw new Error("Credencial de teste ausente");
  const response = await fetch(api + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Mercado Pago respondeu ${response.status}`);
  return await response.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply({ erro: "Método inválido." }, 405);
  try {
    const authorization = req.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return reply({ erro: "Entre no Cola Nessa." }, 401);
    const session = await fetch(db + "/auth/v1/user", {
      headers: { authorization, apikey: anonKey }, signal: AbortSignal.timeout(5000),
    });
    if (!session.ok) return reply({ erro: "Entre no Cola Nessa." }, 401);
    const user = await session.json();
    if (!uuid.test(user.id ?? "") || user.is_anonymous) return reply({ erro: "Entre no Cola Nessa." }, 401);

    const body = await req.json().catch(() => null);
    if (!uuid.test(body?.inscricao ?? "") || !["status", "ativar", "pagar"].includes(body?.acao)) {
      return reply({ erro: "Dados do teste inválidos." }, 400);
    }
    const id = body.inscricao;
    const filter = `?inscricao_id=eq.${id}`;
    const sessionHeaders = { apikey: anonKey, Authorization: authorization };
    const [ins] = await database(`/rest/v1/inscricoes?id=eq.${id}&select=id,dono,status,isento,pago,pago_sinal,valor_pago,credito_usado,comprovante_path,tamanho,dia_unico,valor_combinado,edicoes(id,organizacao_id,gratuita,cancelada_em,preco_dia,preco_2m,preco_3m,preco_unico)`, { headers: sessionHeaders });
    if (!ins?.edicoes) return reply({ erro: "Inscrição indisponível." }, 404);
    const edition = ins.edicoes;
    const owner = ins.dono === user.id;
    if (!owner || body.acao === "ativar") {
      const [profile] = await database(`/rest/v1/perfis?id=eq.${user.id}&select=eh_admin`, { headers: sessionHeaders });
      if (body.acao === "ativar" && !profile?.eh_admin) return reply({ erro: "Acesso restrito à administração." }, 403);
      if (!owner && !profile?.eh_admin) {
        const [member] = await database(`/rest/v1/membros_organizacao?user_id=eq.${user.id}&organizacao_id=eq.${edition.organizacao_id}&select=user_id`);
        if (!member) return reply({ erro: "Inscrição indisponível." }, 404);
      }
    }
    if (body.acao === "pagar" && !owner) return reply({ erro: "Só a pessoa inscrita pode abrir o checkout." }, 403);

    let [row] = await database(payments + filter);
    const value = amountFor(ins, edition);
    if (body.acao === "ativar" && !row) {
      if (!value) return reply({ erro: "Escolha uma inscrição confirmada com valor em aberto, sem sinal, crédito ou comprovante." }, 409);
      await database(payments + "?on_conflict=inscricao_id", {
        method: "POST", headers: { Prefer: "resolution=ignore-duplicates" },
        body: JSON.stringify({ inscricao_id: id, valor: value }),
      });
      [row] = await database(payments + filter);
    }
    if (body.acao === "pagar" && (!row || !value || value !== Number(row.valor))) {
      return reply({ erro: "O teste não está disponível para o valor e o estado atuais da inscrição." }, 409);
    }
    if (!row || row.confirmado_em) return reply(statusOf(row));

    const ref = `colanessa-teste-${row.tentativa}`;
    if (row.order_id) {
      const order = await mercadoPago(`/v1/orders/${row.order_id}`);
      if (order.id !== row.order_id || !testOrderId.test(order.id) || order.external_reference !== ref ||
          Number(order.total_amount) !== Number(row.valor)) {
        return reply({ erro: "A cobrança retornada não corresponde ao teste desta inscrição." }, 502);
      }
      if (order.status === "processed" && order.status_detail === "accredited") {
        await database(payments + filter + "&confirmado_em=is.null", {
          method: "PATCH", body: JSON.stringify({ confirmado_em: new Date().toISOString() }),
        });
        [row] = await database(payments + filter);
      } else if (["expired", "canceled", "cancelled"].includes(order.status)) {
        return reply({ ...statusOf(row), estado: "encerrado" });
      }
    } else if (body.acao === "pagar") {
      const seller = await mercadoPago("/users/me");
      if (Number(seller.id) !== testSellerId) return reply({ erro: "Conta de teste do vendedor não reconhecida." }, 502);
      const callback = `${origin}/feiras/?abrir=ed&id=${edition.id}`;
      const amount = Number(row.valor).toFixed(2);
      const order = await mercadoPago("/v1/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Idempotency-Key": row.tentativa },
        body: JSON.stringify({
          type: "online", processing_mode: "manual", total_amount: amount, external_reference: ref,
          items: [{ title: "Inscrição de teste Cola Nessa", unit_price: amount, quantity: 1 }],
          config: { online: { success_url: callback, pending_url: callback, failure_url: callback, auto_return: "all" } },
        }),
      });
      const checkout = new URL(order.checkout_url);
      if (!testOrderId.test(order.id) || order.external_reference !== ref || Number(order.total_amount) !== Number(row.valor) ||
          checkout.origin !== "https://www.mercadopago.com.br" || checkout.username || checkout.password) {
        return reply({ erro: "O Mercado Pago não retornou um checkout de teste válido." }, 502);
      }
      await database(payments + filter + "&order_id=is.null", {
        method: "PATCH", body: JSON.stringify({ order_id: order.id, checkout_url: checkout.href }),
      });
      [row] = await database(payments + filter);
    }
    return reply({ ...statusOf(row), ...(body.acao === "pagar" && !row.confirmado_em && { checkout: row.checkout_url }) });
  } catch (error) {
    console.error(error instanceof Error ? error.name : "Falha no checkout de teste");
    return reply({ erro: "Não foi possível consultar o pagamento de teste. Tente novamente." }, 502);
  }
});
