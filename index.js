import fs from "fs";
import path from "path";
import FormData from "form-data";
import express from "express";
import axios from "axios";
import axiosRetry from "axios-retry";
import dotenv from "dotenv";
import OpenAI from "openai";
import { crearUsuarioEnDota } from "./services/dotaService.js";
import {
  initDB,
  buscarUsuarioPorTelefono,
  guardarUsuario,
  actualizarUltimaCarga
} from "./services/dbService.js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* ================= ENV ================= */
const {
  KOMMO_LONG_TOKEN,
  SUBDOMAIN_KOMMO,
  KOMMO_FIELD_ID_MENSAJEENVIAR,
  KOMMO_FIELD_ID_CLAVE,
  KOMMO_SALESBOT_RESPUESTA,
  KOMMO_SALESBOT_ID_COMUNIDAD,
  KOMMO_SALESBOT_ID_CBU,
  KOMMO_SALESBOT_ID_RECOMENDAR,
  KOMMO_SALESBOT_ID_RECOMENDE,
  KOMMO_SALESBOT_ID_SOPORTE,
  KOMMO_SALESBOT_ID_RETIRAR,
  KOMMO_SALESBOT_ID_GRATIS,
  KOMMO_SALESBOT_ID_SORTEO,
  KOMMO_SALESBOT_ID_LINK,
  KOMMO_SALESBOT_ID_WAGER,
  KOMMO_SALESBOT_ID_TRANSFIRIO,
  KOMMO_SALESBOT_ID_PRIMERCBU,
  OPENAI_API_KEY,
  DOTA_DOMAIN,
  DOTA_USER,
  DOTA_PASS,
  PORT = 3000
} = process.env;

const DISCORD_WEBHOOK =
  "https://discord.com/api/webhooks/1476056529294594049/I62br6750jtfpNWtYLi0ZWvqV1BgU_iuPiqSdXLBvDSR09bmna5tydeDJbTzzn_l-R7H";

const DOWNLOAD_DIR = path.join(process.cwd(), "comprobantes");
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

const sleep = ms => new Promise(r => setTimeout(r, ms));
/* ================= INIT DB ================= */
await initDB();
/* ================= CONFIG ================= */
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const kommoApi = axios.create({
  baseURL: `https://${SUBDOMAIN_KOMMO}.kommo.com`,
  headers: { Authorization: `Bearer ${KOMMO_LONG_TOKEN}` }
});
axiosRetry(kommoApi, { retries: 3 });
/* ================= MEMORIA ================= */
const memoriaChat = new Map();
const colasDeEspera = new Map();
const bufferMensajes = new Map();
const registrosPendientes = new Map();
const archivosProcesados = new Set();
const MAX_HISTORIAL = 10;

function gestionarMemoria(leadId, nuevoMensaje) {
  if (!memoriaChat.has(leadId)) {
    memoriaChat.set(leadId, []);
  }

  const historial = memoriaChat.get(leadId);

  if (nuevoMensaje) {
    historial.push(nuevoMensaje);
    if (historial.length > MAX_HISTORIAL) historial.shift();
  }

  return historial;
}

async function buscarDesdeLeadFiles(leadId) {
  try {
    const { data } = await kommoApi.get(`/api/v4/leads/${leadId}/files`);
    const files = data._embedded?.files || [];
    console.log("📂 Archivos encontrados:", files.length);

files.forEach((file, index) => {
  console.log(`\n📎 Archivo #${index + 1}`);
  console.log("UUID:", file.file_uuid);
  console.log("Nombre:", file.name);
  console.log("Fecha (timestamp):", file.created_at);
  console.log("Fecha legible:", new Date(file.created_at * 1000));
  console.log("Tamaño:", file.size);
  console.log("Metadata completo:", file.metadata);
  console.log("Tipo MIME:", file.metadata?.mime_type);
  console.log("Objeto completo:", JSON.stringify(file, null, 2));
});
    if (!files.length) return null;

    const fileUuid = files[0].file_uuid;

    const driveApiUrl = `https://drive-c.kommo.com/v1.0/files/${fileUuid}`;

    const { data: driveFile } = await axios.get(driveApiUrl, {
      headers: { Authorization: `Bearer ${KOMMO_LONG_TOKEN}` }
    });

    return driveFile._links?.download?.href;
  } catch {
    return null;
  }
}

async function buscarComprobante(leadId) {
  for (let i = 1; i <= 6; i++) {
    const url = await buscarDesdeLeadFiles(leadId);
    if (url) return url;
    await sleep(2000);
  }
  return null;
}

async function descargarImagen(url, leadId) {
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${KOMMO_LONG_TOKEN}` }
    });

    const filePath = path.join(
      DOWNLOAD_DIR,
      `lead_${leadId}_${Date.now()}.jpg`
    );

    fs.writeFileSync(filePath, response.data);
    return filePath;
  } catch (err) {
    console.log("❌ Error descargando imagen:", err.message);
    return null;
  }
}

async function enviarDiscord(filePath, usuario, leadId) {
  try {
    const form = new FormData();

    form.append(
      "payload_json",
      JSON.stringify({
        content:
`🤵 Usuario: **${usuario}**
🆔 LeadID: ${leadId}`
      })
    );

    form.append("file", fs.createReadStream(filePath));

    await axios.post(DISCORD_WEBHOOK, form, {
      headers: form.getHeaders()
    });

    console.log("✅ Enviado a Discord");

    fs.unlink(filePath, err => {
      if (err) console.log("⚠️ No se pudo borrar archivo:", err.message);
    });

  } catch (err) {
    console.log("❌ Error enviando a Discord:", err.message);
  }
}
/* ================= UTIL ================= */
function getLeadId(body) {
  return (
    body?.leads?.status?.[0]?.id ||
    body?.leads?.add?.[0]?.id ||
    body?.leads?.update?.[0]?.id ||
    body?.lead_id ||
    null
  );
}
function normalizarTelefono(tel) {
  return tel?.replace(/\D/g, "") || null;
}

function obtenerHoraArgentina() {
  const ahora = new Date();

  const argentina = new Date(
    ahora.toLocaleString("en-US", {
      timeZone: "America/Argentina/Buenos_Aires"
    })
  );

  return argentina.getHours();
}
function saludoCompleto(usuarioExistente) {

  const horaArgentina = obtenerHoraArgentina();

  let saludo;

  if (horaArgentina >= 6 && horaArgentina < 12) {
    saludo = "buenos días❤️";
  } else if (horaArgentina >= 12 && horaArgentina < 20) {
    saludo = "buenas tardes⭐";
  } else {
    saludo = "buenas noches✨";
  }

  const nombre = usuarioExistente?.nombre_usuario
    ? usuarioExistente.nombre_usuario
    : "corazón";

  return `${saludo} ${nombre}, te paso CBU?`;
}

function calcularBono(usuario) {
  if (!usuario) return "200% por primera carga ❤️";

  const hora = obtenerHoraArgentina();
  if (hora >= 0 && hora <= 12) return "50% turno mañana ❤️";
  if (hora > 12 && hora <= 20) return "30% turno tarde ❤️";
  return "20% turno noche ❤️";
}
/* ================= DETECTOR NOMBRE ================= */
async function detectarNombreIA(mensaje) {

  const prompt = `
Analiza el mensaje del usuario.

Responde SOLO JSON.

Posibles respuestas:
- nombre_valido
- no_es_nombre

Mensaje:
"${mensaje}"

Devuelve:
{"resultado":"tipo"}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }]
  });

  return JSON.parse(completion.choices[0].message.content);
}
/* ================= DETECTOR INTELIGENTE ================= */
async function detectarAccionIA(mensaje) {

  const prompt = `
Analiza el mensaje del cliente y responde SOLO JSON.

Tu tarea es clasificar el mensaje en UNA de estas acciones:

- saludo → saludos simples (hola, buenas, etc.)
- bono → preguntas sobre bonos o beneficios
- accesos → quiere entrar, acceder, usuario, clave, cuenta
- comunidad → pide grupo, comunidad, trivia, juegos ganadores 
- cbu → pide datos de pago, cuenta, cbu, transferencia, donde cargo, cargar o fichas
- transfirio → ya trasnfirio, ya pago, ya envio su pago, ya cargó, ya mandó
- recomendar → quiere invitar, referir, recomendar, como recomiendo?
- recomende → ya refirio, invito, recomendo, te mandé uno
- gratis → quiere gratis, fichas de regalo, dan fichas para probar, como gano fichas gratis
- retirar → quiere retirar, cobrar premio, retirar saldo, bajar fichas, gene un premio, como retiro
- sorteo → sorteo, como participo del sorteo, gane el sorteo, donde se sortea, ya sortearon?
- link → link de la plataforma, plataforma, pasame el link para jugar, donde juego?
- wager → que juegos aceptan bono?, cuales juego puedo jugar con bono?, como uso el bono?
- soporte → problemas, errores, reclamos, pagos no acreditados, bloqueos, o necesita ayuda humana
- conversacion → agradecimientos, respuestas triviales o conversación sin intención clara

Reglas obligatorias:

- Si el usuario reporta un problema, error, pago no acreditado, bloqueo o reclamo → soporte
- Si el usuario necesita ayuda humana → soporte
- Si el mensaje es trivial como "gracias", "ok", "perfecto", etc. → conversacion
- Si el mensaje tiene intención clara de alguna acción específica → usar esa acción
- Si hay duda entre conversacion y soporte, prioriza soporte si hay un problema

Mensaje del cliente:
"${mensaje}"

Responde SOLO este formato JSON:
{"accion":"tipo"}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0, // importante para clasificación consistente
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Eres un clasificador de intenciones. Responde únicamente JSON válido."
      },
      {
        role: "user",
        content: prompt
      }
    ]
  });

  return JSON.parse(completion.choices[0].message.content);
}

/* ================= FLUJO PRINCIPAL ================= */
async function procesarFlujoGPT(leadId, mensajeUnificado) {

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

    const { data: lead } = await kommoApi.get(
      `/api/v4/leads/${leadId}`,
      { params: { with: "contacts" } }
    );

    const contactoId = lead._embedded?.contacts?.[0]?.id;

    if (!contactoId) {
      console.log("⚠️ Lead sin contacto asociado");
      return;
    }

    const { data: contacto } = await kommoApi.get(
      `/api/v4/contacts/${contactoId}`
    );

    const telefonoRaw = contacto.custom_fields_values?.find(
      f => f.field_code === "PHONE"
    )?.values?.[0]?.value;

    const telefono = normalizarTelefono(telefonoRaw);

    if (!telefono) {
      console.log("⚠️ Contacto sin teléfono válido");
      return;
    }

    const usuarioExistente = await buscarUsuarioPorTelefono(telefono);

/* ======================================================
   AUTO-REGISTRO SI ENVÍA NOMBRE DIRECTAMENTE
====================================================== */

if (!usuarioExistente) {

  const analisisNombreDirecto = await detectarNombreIA(mensajeUnificado);

  if (analisisNombreDirecto?.resultado === "nombre_valido") {

    console.log("🆕 Nombre detectado sin contexto previo. Creando usuario...");

    const nombre = mensajeUnificado.trim();

    const nuevoUsuario = await crearUsuarioEnDota({
      nombreBase: nombre,
      DOTA_DOMAIN,
      DOTA_USER,
      DOTA_PASS
    });

    if (!nuevoUsuario?.loginNuevo || !nuevoUsuario?.passDota) {

      await enviarMensajeYBot(
        leadId,
        "Hubo un problema creando tu usuario. Intentá nuevamente en unos segundos."
      );

      return;
    }

    await guardarUsuario({
      telefono,
      nombre_usuario: nuevoUsuario.loginNuevo,
      clave: nuevoUsuario.passDota
    });

    const mensajeBienvenida =
`Listo ${nombre}, ya está liso.
Usuario: ${nuevoUsuario.loginNuevo}
Clave: ${nuevoUsuario.passDota}`;

    await kommoApi.patch("/api/v4/leads", [
      {
        id: Number(leadId),
        name: nuevoUsuario.loginNuevo,
        custom_fields_values: [
          {
            field_id: Number(KOMMO_FIELD_ID_CLAVE),
            values: [{ value: nuevoUsuario.passDota }]
          },
          {
            field_id: Number(KOMMO_FIELD_ID_MENSAJEENVIAR),
            values: [{ value: mensajeBienvenida }]
          }
        ]
      }
    ]);

    await ejecutarSalesbot(leadId, KOMMO_SALESBOT_RESPUESTA);
    await ejecutarSalesbot(leadId, KOMMO_SALESBOT_ID_PRIMERCBU);

    return;
  }
}

    /* ======================================================
       REGISTRO INTELIGENTE
    ====================================================== */

    if (!usuarioExistente && registrosPendientes.has(leadId)) {

      const analisis = await detectarNombreIA(mensajeUnificado);

      if (analisis?.resultado === "nombre_valido") {

        const nombre = mensajeUnificado.trim();

        const nuevoUsuario = await crearUsuarioEnDota({
          nombreBase: nombre,
          DOTA_DOMAIN,
          DOTA_USER,
          DOTA_PASS
        });

        if (!nuevoUsuario?.loginNuevo || !nuevoUsuario?.passDota) {

          await enviarMensajeYBot(
            leadId,
            "Hubo un problema creando tu usuario. Intentá nuevamente en unos segundos."
          );

          return;
        }

        await guardarUsuario({
          telefono,
          nombre_usuario: nuevoUsuario.loginNuevo,
          clave: nuevoUsuario.passDota
        });

        registrosPendientes.delete(leadId);

        const mensajeBienvenida =
`Listo ${nombre}, ya está listo.
Usuario: ${nuevoUsuario.loginNuevo}
Clave: ${nuevoUsuario.passDota}`;

        await kommoApi.patch("/api/v4/leads", [
          {
            id: Number(leadId),
            name: nuevoUsuario.loginNuevo,
            custom_fields_values: [
              {
                field_id: Number(KOMMO_FIELD_ID_CLAVE),
                values: [{ value: nuevoUsuario.passDota }]
              },
              {
                field_id: Number(KOMMO_FIELD_ID_MENSAJEENVIAR),
                values: [{ value: mensajeBienvenida }]
              }
            ]
          }
        ]);

        await ejecutarSalesbot(leadId, KOMMO_SALESBOT_RESPUESTA);
        await ejecutarSalesbot(leadId, KOMMO_SALESBOT_ID_PRIMERCBU);

        return;
      }

      await enviarMensajeYBot(
        leadId,
        "Necesito tu nombre o apodo para poder registrarte."
      );

      return;
    }

    /* ======================================================
       DETECTAR INTENCIÓN
    ====================================================== */

    const { accion } = await detectarAccionIA(mensajeUnificado);

    console.log("🧠 Acción detectada:", accion);

    /* ======================================================
       SOPORTE (PRIORIDAD MÁXIMA)
    ====================================================== */

if (accion === "saludo") {
  await enviarMensajeYBot(
    leadId,
    saludoCompleto(usuarioExistente)
  );
  return;
}
    if (accion === "soporte") {

      return await ejecutarSalesbot(
        leadId,
        KOMMO_SALESBOT_ID_SOPORTE
      );

    }

/* ======================================================
   MAPA DE ACCIONES GENERALES (NO dependen de registro)
====================================================== */

const accionesGenerales = {
  comunidad: () => ejecutarSalesbot(leadId, KOMMO_SALESBOT_ID_COMUNIDAD),
  recomendar: () => ejecutarSalesbot(leadId, KOMMO_SALESBOT_ID_RECOMENDAR),
  recomende: () => ejecutarSalesbot(leadId, KOMMO_SALESBOT_ID_RECOMENDE),
  retirar: () => ejecutarSalesbot(leadId, KOMMO_SALESBOT_ID_RETIRAR),
  gratis: () => ejecutarSalesbot(leadId, KOMMO_SALESBOT_ID_GRATIS),
  sorteo: () => ejecutarSalesbot(leadId, KOMMO_SALESBOT_ID_SORTEO),
  link: () => ejecutarSalesbot(leadId, KOMMO_SALESBOT_ID_LINK),
  wager: () => ejecutarSalesbot(leadId, KOMMO_SALESBOT_ID_WAGER),
  transfirio: () => ejecutarSalesbot(leadId, KOMMO_SALESBOT_ID_TRANSFIRIO),
  cbu: () => ejecutarSalesbot(leadId, KOMMO_SALESBOT_ID_CBU),
};


/* ======================================================
   USUARIO NO EXISTE
====================================================== */

if (!usuarioExistente) {

  if (accion === "accesos") {

    registrosPendientes.set(leadId, true);

    await enviarMensajeYBot(
      leadId,
      "Para darte accesos primero necesito registrarte. ¿Cómo te llamas?"
    );

    return;
  }

  if (accion === "bono") {

    const textoBono = calcularBono(null);

    await enviarMensajeYBot(
      leadId,
      `Bono disponible: ${textoBono}`
    );

    return;
  }

  // 🔥 Acciones que funcionan igual para todos
  if (accionesGenerales[accion]) {
    return await accionesGenerales[accion]();
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

  await enviarMensajeYBot(leadId, respuestaIA);

  return;
}


/* ======================================================
   USUARIO EXISTE
====================================================== */

if (accion === "accesos") {

  const msg =
`Tus accesos:
Usuario: ${usuarioExistente.nombre_usuario}
Clave: ${usuarioExistente.clave}`;

  await enviarMensajeYBot(leadId, msg);

  return;
}

if (accion === "bono") {

  const textoBono = calcularBono(usuarioExistente);

  await enviarMensajeYBot(
    leadId,
    `Bono disponible: ${textoBono}`
  );

  return;
}

// 🔥 Acciones generales reutilizadas
if (accionesGenerales[accion]) {
  return await accionesGenerales[accion]();
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

    await enviarMensajeYBot(leadId, respuestaIA);

  } catch (error) {

    console.error(
      "❌ Error en procesarFlujoGPT:",
      error.response?.data || error.message
    );

  } finally {

    colasDeEspera.delete(leadId);

  }
}
/* ================= HELPERS ================= */
async function enviarMensajeYBot(leadId, mensaje) {
  await kommoApi.patch(`/api/v4/leads/${leadId}`, {
    custom_fields_values: [
      {
        field_id: Number(KOMMO_FIELD_ID_MENSAJEENVIAR),
        values: [{ value: mensaje }]
      }
    ]
  });

  await ejecutarSalesbot(leadId, KOMMO_SALESBOT_RESPUESTA);
}

async function ejecutarSalesbot(leadId, botId) {
  await kommoApi.post("/api/v2/salesbot/run", [
    {
      bot_id: Number(botId),
      entity_id: Number(leadId),
      entity_type: 2
    }
  ]);
}

/* ================= WEBHOOK ================= */

app.post("/webhook-kommo", async (req, res) => {

  const leadId = getLeadId(req.body);
  if (!leadId) return res.sendStatus(200);

  try {

    const { data: lead } = await kommoApi.get(
      `/api/v4/leads/${leadId}`
    );

    const mensajeCliente =
      lead.custom_fields_values?.find(
        f => f.field_id == KOMMO_FIELD_ID_MENSAJEENVIAR
      )?.values?.[0]?.value;


// ================= IMAGEN O MENSAJE =================

if (!mensajeCliente || mensajeCliente.trim() === "") {

  console.log("🖼️ Posible archivo recibido. Buscando última imagen válida...");

  try {

    const { data } = await kommoApi.get(`/api/v4/leads/${leadId}/files`);
    const files = data._embedded?.files || [];

    if (!files.length) {
      await enviarMensajeYBot(
        leadId,
        "No puedo recibir audios ni emojis, solo texto y capturas de comprobante porfis"
      );
      return res.sendStatus(200);
    }

    let archivosDrive = [];

    // 🔎 Obtener info real desde Drive
    for (const file of files) {

      const driveApiUrl = `https://drive-c.kommo.com/v1.0/files/${file.file_uuid}`;

      const { data: driveFile } = await axios.get(driveApiUrl, {
        headers: { Authorization: `Bearer ${KOMMO_LONG_TOKEN}` }
      });

      archivosDrive.push(driveFile);
    }

    // 🔥 Ordenar por fecha (más reciente primero)
    archivosDrive.sort((a, b) => b.created_at - a.created_at);

    // 🔍 Buscar primera imagen válida
    const imagenValida = archivosDrive.find(file => {

      // Solo imágenes
      if (file.type !== "image") return false;

      // Solo enviadas por el usuario (no internas del sistema)
      if (file.created_by?.type !== "external") return false;

      // Validar antigüedad (10 minutos)
      const ahora = Math.floor(Date.now() / 1000); // en segundos
      const diferenciaMinutos = (ahora - file.created_at) / 60;

      if (diferenciaMinutos > 10) return false;

      // No reprocesar
      if (archivosProcesados.has(file.uuid)) return false;

      return true;
    });

    if (!imagenValida) {
      await enviarMensajeYBot(
        leadId,
        "No puedo recibir audios ni emojis, solo texto y capturas de comprobante porfis"
      );
      return res.sendStatus(200);
    }

    archivosProcesados.add(imagenValida.uuid);

    const downloadUrl = imagenValida._links?.download?.href;

    if (!downloadUrl) return res.sendStatus(200);

    const filePath = await descargarImagen(downloadUrl, leadId);
    if (!filePath) return res.sendStatus(200);

    // 🔍 Obtener usuario por teléfono
    const { data: leadFull } = await kommoApi.get(
      `/api/v4/leads/${leadId}`,
      { params: { with: "contacts" } }
    );

    const contactoId = leadFull._embedded?.contacts?.[0]?.id;

    let nombreUsuario = "NO REGISTRADO";

    if (contactoId) {
      const { data: contacto } = await kommoApi.get(
        `/api/v4/contacts/${contactoId}`
      );

      const telefonoRaw = contacto.custom_fields_values?.find(
        f => f.field_code === "PHONE"
      )?.values?.[0]?.value;

      const telefono = normalizarTelefono(telefonoRaw);

      if (telefono) {
        const usuarioDB = await buscarUsuarioPorTelefono(telefono);
        if (usuarioDB) nombreUsuario = usuarioDB.nombre_usuario;
      // 🔒 Si no existe usuario aún, NO enviar a Discord
if (!usuarioDB) {

  await enviarMensajeYBot(
    leadId,
    "Genial, ahora solo queda crear tu usuario. Decime tu nombre así lo creo!"
  );

  return res.sendStatus(200);
}
      }
    }

    await enviarDiscord(filePath, nombreUsuario, leadId);

    return res.sendStatus(200);

  } catch (err) {
    console.log("❌ Error procesando archivo:", err.message);
    return res.sendStatus(200);
  }
}
    console.log("📩 Mensaje recibido:", mensajeCliente);

    if (!bufferMensajes.has(leadId)) {
      bufferMensajes.set(leadId, []);
    }

    bufferMensajes.get(leadId).push(mensajeCliente);

    if (colasDeEspera.has(leadId)) {
      clearTimeout(colasDeEspera.get(leadId));
    }

    const timeoutId = setTimeout(async () => {

      const mensajesFinales = bufferMensajes.get(leadId) || [];
      const mensajeUnificado = mensajesFinales.join(" ");

      console.log("🧠 Procesando mensaje unificado:", mensajeUnificado);

      bufferMensajes.delete(leadId);

      await procesarFlujoGPT(leadId, mensajeUnificado);

    }, 5000);

    colasDeEspera.set(leadId, timeoutId);

  } catch (error) {
    console.error("Error en webhook:", error.message);
  }

  res.sendStatus(200);
});

/* ================= WEBHOOK OCR (DESDE PYTHON) ================= */

app.post("/webhook-ocr", async (req, res) => {

  const { lead_id, resultado, monto } = req.body;

  if (!lead_id || !resultado) {
    return res.sendStatus(400);
  }

  console.log("📡 Resultado OCR recibido:", lead_id, resultado);

  try {

    let mensaje = "";

    switch (resultado) {

case "exito":

  mensaje = "Comprobante verificado correctamente. Tu carga fue acreditada.";

  try {

    // 🔎 Obtener teléfono desde el lead
    const { data: leadFull } = await kommoApi.get(
      `/api/v4/leads/${lead_id}`,
      { params: { with: "contacts" } }
    );

    const contactoId = leadFull._embedded?.contacts?.[0]?.id;

    if (contactoId) {

      const { data: contacto } = await kommoApi.get(
        `/api/v4/contacts/${contactoId}`
      );

      const telefonoRaw = contacto.custom_fields_values?.find(
        f => f.field_code === "PHONE"
      )?.values?.[0]?.value;

      const telefono = normalizarTelefono(telefonoRaw);

      if (telefono && monto) {
        await actualizarUltimaCarga(telefono, monto);
        console.log("💾 Última carga actualizada:", telefono, monto);
      }
    }

  } catch (err) {
    console.log("❌ Error guardando última carga:", err.message);
  }

  break;

      case "duplicado":
        mensaje = "Este comprobante ya fue enviado anteriormente. Si crees que es un error avisanos.";
        break;

      case "pendiente":
        mensaje = "Recibimos tu comprobante. Está en revisión y te confirmaremos en breve.";
        break;

      case "error_ocr":
        mensaje = "No pudimos leer el comprobante. Enviá una imagen más clara por favor.";
        break;

      case "error_descarga":
        mensaje = "No pudimos procesar la imagen. Intentá reenviarla.";
        break;

      case "error_servidor":
      case "error_critico":
        mensaje = "Hubo un problema procesando tu comprobante. Intentá nuevamente.";
        break;

      default:
        mensaje = "Tu comprobante fue recibido.";
    }

    await enviarMensajeYBot(lead_id, mensaje);

    res.sendStatus(200);

  } catch (error) {

    console.error("❌ Error en webhook-ocr:", error.message);
    res.sendStatus(500);

  }

});

/* ================= FIN ================= */
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});

