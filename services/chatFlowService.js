import {buscarUsuarioPorTelefono,guardarUsuario} from "./dbService.js";
import {obtenerTelefono,saludoCompleto,calcularBono} from "../utils/utilsGenerales.js";
import {colasDeEspera,registrosPendientes,gestionarMemoria} from "./chatMemory.js";
import { enviarMensajeYBot, ejecutarSalesbot } from "./kommoBotService.js";
import { registrarUsuario } from "./registerUser.js";
import { detectarNombreIA, detectarAccionIA } from "./aiService.js";
import { buscarUsuarioEnKommoPorTelefono } from "./syncKommoUser.js";
import { cacheLeadData } from "./chatMemory.js";

/* ================= FLUJO PRINCIPAL ================= */
export async function procesarFlujoGPT(leadId, mensajeUnificado, config, kommoApi, openai, clienteId) {

  const SYSTEM_PROMPT_NO_REGISTRADO = `
Eres una mujer asistente oficial de una plataforma de juegos online.

Tu objetivo es guiar al usuario a obtener sus accesos, conocer bonos o unirse a la comunidad.

Reglas obligatorias:

- Usa máximo 2–3 frases
- No uses emojis
- No inventes información
- Usa tono natural y profesional
- No tengas conversaciones innecesarias

Comportamiento:

- Si el usuario dice gracias, ok o mensajes triviales, redirígelo hacia obtener accesos o conocer beneficios
- Incentiva el registro de forma natural
- Nunca menciones procesos internos
`;

  const SYSTEM_PROMPT_REGISTRADO = `
Eres una mujer asistente oficial de una plataforma de juegos online.

El usuario ya tiene cuenta.

Tu objetivo es ayudarlo y guiarlo hacia bonos, comunidad o uso de la plataforma.

Reglas obligatorias:

- Usa máximo 2–3 frases
- No uses emojis
- No inventes información
- Usa tono natural y profesional
- No tengas conversaciones innecesarias

Comportamiento:

- Si el mensaje es trivial, redirígelo hacia bonos o comunidad
- Nunca menciones procesos internos
`;

  try {

console.log(`🎬 Procesando Lead: ${leadId}`);

let telefono;
let contactoId;

let leadData = cacheLeadData.get(leadId);

if (!leadData) {

  const { data: lead } = await kommoApi.get(
    `/api/v4/leads/${leadId}`,
    { params: { with: "contacts" } }
  );

  contactoId = lead._embedded?.contacts?.[0]?.id;

  if (!contactoId) {
    console.log("⚠️ Lead sin contacto asociado");
    return;
  }

  const { data: contacto } = await kommoApi.get(
    `/api/v4/contacts/${contactoId}`
  );

  telefono = obtenerTelefono(contacto);

  if (!telefono) {
    console.log("⚠️ Contacto sin teléfono válido");
    return;
  }

  leadData = { telefono, contactoId };

  cacheLeadData.set(leadId, leadData);

} else {

  telefono = leadData.telefono;
  contactoId = leadData.contactoId;

}

    let usuarioExistente = await buscarUsuarioPorTelefono(telefono, clienteId);

if (!usuarioExistente) {

  console.log("🔎 Usuario no encontrado en DB, buscando en Kommo...");

  try {

    const usuarioKommo = await buscarUsuarioEnKommoPorTelefono(
      telefono,
      config,
      kommoApi
    );

    if (usuarioKommo) {

      console.log("🔄 Usuario encontrado en Kommo, sincronizando...");

      await guardarUsuario({
        telefono,
        nombre_usuario: usuarioKommo.nombre_usuario,
        clave: usuarioKommo.clave,
        cliente: clienteId
      });

      // simulamos el usuario como si viniera de la DB
      usuarioExistente = {
        telefono,
        nombre_usuario: usuarioKommo.nombre_usuario,
        clave: usuarioKommo.clave
      };

      console.log("✅ Usuario sincronizado desde Kommo");

    } else {

      console.log("ℹ️ No existe usuario válido en Kommo");

    }

  } catch (e) {

    console.log("⚠️ Error buscando usuario en Kommo:", e.message);

  }

}

/* ======================================================
   AUTO-REGISTRO SI ENVÍA NOMBRE DIRECTAMENTE
====================================================== */
if (!usuarioExistente) {
  const analisisNombreDirecto = await detectarNombreIA(mensajeUnificado, openai);
  if (analisisNombreDirecto?.resultado === "nombre_valido") {
    await registrarUsuario({
      leadId,
      nombre: analisisNombreDirecto.nombre,
      telefono,
      clienteId,
      config,
      kommoApi
    });
    return;
  }
}
    /* ======================================================
       REGISTRO INTELIGENTE
    ====================================================== */
if (!usuarioExistente && registrosPendientes.has(leadId)) {

  const analisis = await detectarNombreIA(mensajeUnificado, openai);

  if (analisis?.resultado === "nombre_valido") {

    await registrarUsuario({
      nombre: analisis.nombre,
      telefono,
      leadId,
      clienteId,
      config,
      kommoApi
    });

    registrosPendientes.delete(leadId);
    return;
  }

  await enviarMensajeYBot(
    leadId,
    "Necesito tu nombre o apodo para poder registrarte.",
    config,
    kommoApi
  );

  return;
}

    /* ======================================================
       DETECTAR INTENCIÓN
    ====================================================== */

    const { accion } = await detectarAccionIA(mensajeUnificado, openai);

    console.log("🧠 Acción detectada:", accion);

    /* ======================================================
       SOPORTE (PRIORIDAD MÁXIMA)
    ====================================================== */

if (accion === "saludo") {
  await enviarMensajeYBot(
    leadId,
    saludoCompleto(usuarioExistente), config, kommoApi
  );
    await ejecutarSalesbot(
    leadId,
    config.KOMMO_SALESBOT_ID_ELEGIR, 
    kommoApi
  );
  return;
}
    if (accion === "soporte") {

      return await ejecutarSalesbot(
        leadId,
        config.KOMMO_SALESBOT_ID_SOPORTE, kommoApi
      );

    }

/* ======================================================
   MAPA DE ACCIONES GENERALES (NO dependen de registro)
====================================================== */
const accionesGenerales = {
  comunidad: "KOMMO_SALESBOT_ID_COMUNIDAD",
  recomendar: "KOMMO_SALESBOT_ID_RECOMENDAR",
  recomende: "KOMMO_SALESBOT_ID_RECOMENDE",
  retirar: "KOMMO_SALESBOT_ID_RETIRAR",
  gratis: "KOMMO_SALESBOT_ID_GRATIS",
  sorteo: "KOMMO_SALESBOT_ID_SORTEO",
  link: "KOMMO_SALESBOT_ID_LINK",
  wager: "KOMMO_SALESBOT_ID_WAGER",
  transfirio: "KOMMO_SALESBOT_ID_TRANSFIRIO",
  cbu: "KOMMO_SALESBOT_ID_CBU"
};
/* ======================================================
   USUARIO NO EXISTE
====================================================== */

if (!usuarioExistente) {

  if (accion === "accesos") {

    registrosPendientes.set(leadId, true);

    await enviarMensajeYBot(
      leadId,
      "Para darte accesos primero necesito registrarte. ¿Cómo te llamas?", config, kommoApi
    );

    return;
  }

  if (accion === "bono") {

    const textoBono = calcularBono(null, config);

    await enviarMensajeYBot(
      leadId,
      `Bono disponible: ${textoBono}`, config, kommoApi
    );

    return;
  }

  // 🔥 Acciones que funcionan igual para todos
 if (accionesGenerales[accion]) {
  return await ejecutarSalesbot(
    leadId,
    config[accionesGenerales[accion]],
    kommoApi
  );
}

  /* ===== CONVERSACIÓN IA ===== */

  const historial = gestionarMemoria(leadId, {
    role: "user",
    content: mensajeUnificado
  });

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.7,
    messages: [
      { role: "system", content: SYSTEM_PROMPT_NO_REGISTRADO },
      ...historial
    ]
  });

  const respuestaIA = completion.choices[0].message.content;

  gestionarMemoria(leadId, {
    role: "assistant",
    content: respuestaIA
  });

  await enviarMensajeYBot(leadId, respuestaIA, config, kommoApi);

  return;
}


/* ======================================================
   USUARIO EXISTE
====================================================== */

if (accion === "accesos") {

  const msg =
`Ya tenes usuario, tus accesos:
Usuario: ${usuarioExistente.nombre_usuario}
Clave: ${usuarioExistente.clave}`;

  await enviarMensajeYBot(leadId, msg, config, kommoApi);

  return;
}

if (accion === "bono") {

  const textoBono = calcularBono(usuarioExistente, config);

  await enviarMensajeYBot(
    leadId,
    `Bono disponible: ${textoBono}`, config, kommoApi
  );

  return;
}

// 🔥 Acciones generales reutilizadas
if (accionesGenerales[accion]) {
  return await ejecutarSalesbot(
    leadId,
    config[accionesGenerales[accion]],
    kommoApi
  );
}
    /* ===== CONVERSACIÓN CONTROLADA ===== */

    const historial = gestionarMemoria(leadId, {
      role: "user",
      content: mensajeUnificado
    });

    const completion = await openai.chat.completions.create({

      model: "gpt-4o-mini",

      temperature: 0.7,

      messages: [
        { role: "system", content: SYSTEM_PROMPT_REGISTRADO },
        ...historial
      ]

    });

    const respuestaIA = completion.choices[0].message.content;

    gestionarMemoria(leadId, {
      role: "assistant",
      content: respuestaIA
    });

    await enviarMensajeYBot(leadId, respuestaIA, config, kommoApi);

  } catch (error) {

    console.error(
      "❌ Error en procesarFlujoGPT:",
      error.response?.data || error.message
    );

  } finally {
    colasDeEspera.delete(leadId);
  }
}