const headers = {
  "Cache-Control": "no-store",
  "Content-Type": "text/plain; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

Deno.serve((request) => {
  if (request.method !== "GET") {
    return new Response("Método inválido.", {
      status: 405,
      headers: { ...headers, Allow: "GET" },
    });
  }

  const params = new URL(request.url).searchParams;
  if (params.has("code") || params.has("state") || params.has("error")) {
    return new Response("A conexão do Mercado Pago ainda não está disponível no Cola Nessa.", {
      status: 503,
      headers,
    });
  }

  return new Response("Cola Nessa — endereço de retorno do Mercado Pago.", { headers });
});
