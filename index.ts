import { createClient } from "npm:@supabase/supabase-js@2";

const ORIGEN_PERMITIDO = "https://cristian93931.github.io/";
const MODELO = "gpt-4o-mini";
const MAX_ANALISIS_POR_HORA = 10;
const MAX_DOCENTES = 50;
const CLAVE_CONFIG = "openai_api_key";

const cors = {
  "Access-Control-Allow-Origin": ORIGEN_PERMITIDO,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// Cliente con la clave de servicio: solo existe dentro de la función
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function leerClave(): Promise<string | null> {
  const { data, error } = await admin.from("configuracion")
    .select("valor").eq("clave", CLAVE_CONFIG).maybeSingle();
  if (error) throw error;
  return data?.valor ?? null;
}

function calificacion(total: number): string {
  if (total <= 50) return "DEFICIENTE";
  if (total <= 80) return "BUENO";
  if (total <= 90) return "MUY BUENO";
  return "EXCELENTE";
}

// Acota un número al rango [0, max]; cualquier valor inválido queda en 0
function num(v: unknown, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
    // 1) Autenticación: el token debe pertenecer a una sesión válida
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "No autenticado" }, 401);
    const { data: auth, error: authErr } = await admin.auth.getUser(token);
    const user = auth?.user;
    if (authErr || !user) return json({ error: "Sesión no válida. Vuelve a iniciar sesión." }, 401);

    // 2) Autorización: el rol se comprueba en el servidor, no en la interfaz
    const { data: perfil, error: perfilErr } = await admin.from("perfiles")
      .select("rol").eq("id", user.id).maybeSingle();
    if (perfilErr) throw perfilErr;
    if (perfil?.rol !== "administrador") {
      return json({ error: "Solo el administrador puede usar esta función" }, 403);
    }

    const body = await req.json().catch(() => ({}));

    switch (body?.accion) {
      // ── Estado: nunca devuelve la clave, solo sus 4 últimos caracteres ──
      case "estado": {
        const { data, error } = await admin.from("configuracion")
          .select("valor, updated_at").eq("clave", CLAVE_CONFIG).maybeSingle();
        if (error) throw error;
        if (!data) return json({ configurada: false });
        return json({
          configurada: true,
          terminacion: data.valor.slice(-4),
          actualizada: data.updated_at,
        });
      }

      // ── Guardar: valida el formato y la prueba contra OpenAI antes de guardar ──
      case "guardar_clave": {
        const clave = String(body.clave ?? "").trim();
        if (!/^sk-[A-Za-z0-9_\-]{20,200}$/.test(clave)) {
          return json({ error: "La API Key no tiene un formato válido (debe empezar con sk-)" }, 400);
        }
        const prueba = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${clave}` },
        });
        if (prueba.status === 401) {
          return json({ error: "OpenAI rechazó la API Key. Verifica que esté activa." }, 400);
        }
        if (!prueba.ok) {
          return json({ error: "No se pudo verificar la API Key con OpenAI. Intenta de nuevo." }, 502);
        }
        const { error } = await admin.from("configuracion").upsert({
          clave: CLAVE_CONFIG,
          valor: clave,
          updated_at: new Date().toISOString(),
          updated_by: user.id,
        });
        if (error) throw error;
        await admin.from("ia_uso").insert({ usuario_id: user.id, accion: "guardar_clave" });
        return json({ configurada: true, terminacion: clave.slice(-4) });
      }

      case "eliminar_clave": {
        const { error } = await admin.from("configuracion").delete().eq("clave", CLAVE_CONFIG);
        if (error) throw error;
        await admin.from("ia_uso").insert({ usuario_id: user.id, accion: "eliminar_clave" });
        return json({ configurada: false });
      }

      // ── Analizar ──
      case "analizar": {
        const clave = await leerClave();
        if (!clave) return json({ error: "Aún no se ha configurado la API Key de OpenAI" }, 400);

        // Límite de uso por administrador, para acotar el gasto
        const desde = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { count, error: countErr } = await admin.from("ia_uso")
          .select("id", { count: "exact", head: true })
          .eq("usuario_id", user.id).eq("accion", "analizar").gte("created_at", desde);
        if (countErr) throw countErr;
        if ((count ?? 0) >= MAX_ANALISIS_POR_HORA) {
          return json({ error: `Límite de ${MAX_ANALISIS_POR_HORA} análisis por hora alcanzado. Intenta más tarde.` }, 429);
        }

        // El navegador solo envía los datos; se validan y el prompt se arma aquí
        const filas = Array.isArray(body.resultados) ? body.resultados.slice(0, MAX_DOCENTES) : [];
        if (!filas.length) return json({ error: "No hay resultados para analizar" }, 400);

        const tabla = filas.map((r: Record<string, unknown>) => {
          const docente = String(r?.docente ?? "Sin nombre").replace(/[\r\n]+/g, " ").slice(0, 80);
          const hetero = num(r?.hetero, 30);
          const auto = num(r?.auto, 10);
          const coe = num(r?.coe, 60);
          const total = Math.round((hetero + auto + coe) * 100) / 100;
          return `- ${docente}: Heteroevaluación=${hetero.toFixed(2)}, Autoevaluación=${auto.toFixed(2)}, ` +
            `Coevaluación=${coe.toFixed(2)}, Total=${total.toFixed(2)}, Calificación=${calificacion(total)}`;
        }).join("\n");

        const prompt =
          "Eres un experto en evaluación docente de instituciones de educación superior. " +
          "Analiza los siguientes resultados de evaluación docente y proporciona un análisis detallado, " +
          "constructivo y profesional en español. Incluye: 1) Análisis general del proceso evaluativo, " +
          "2) Fortalezas identificadas en cada docente, 3) Áreas de mejora, 4) Recomendaciones institucionales concretas.\n\n" +
          `Resultados:\n${tabla}\n\n` +
          "Escala: 0-50 Deficiente, 51-80 Bueno, 81-90 Muy Bueno, 91-100 Excelente. " +
          "Los instrumentos son: Heteroevaluación (30 pts, por estudiantes), Autoevaluación (10 pts, por docentes), " +
          "Coevaluación (60 pts, por personal académico).";

        await admin.from("ia_uso").insert({ usuario_id: user.id, accion: "analizar" });

        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${clave}` },
          body: JSON.stringify({
            model: MODELO,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1200,
            temperature: 0.7,
          }),
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok) {
          // El detalle queda en los registros del servidor; al navegador va un mensaje genérico
          console.error("OpenAI respondió", resp.status, data?.error?.type, data?.error?.code);
          const msg = resp.status === 401
            ? "OpenAI rechazó la API Key guardada. Reemplázala desde el panel."
            : resp.status === 429
            ? "OpenAI informó límite de uso o saldo insuficiente."
            : "OpenAI no pudo completar el análisis. Intenta de nuevo.";
          return json({ error: msg }, 502);
        }
        return json({ texto: data?.choices?.[0]?.message?.content ?? "Sin respuesta" });
      }

      default:
        return json({ error: "Acción no reconocida" }, 400);
    }
  } catch (e) {
    console.error("Error en analisis-ia:", e);
    return json({ error: "Error interno del servidor" }, 500);
  }
});
