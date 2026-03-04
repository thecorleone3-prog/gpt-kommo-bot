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

const DOWNLOAD_DIR = path.join(process.cwd(), "comprobantes");
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

const sleep = ms => new Promise(r => setTimeout(r, ms));
/* ================= INIT DB ================= */
await initDB();

/* ================= MEMORIA ================= */
const memoriaChat = new Map();
const colasDeEspera = new Map();
const bufferMensajes = new Map();
const registrosPendientes = new Map();
const archivosProcesados = new Map();
const TIEMPO_EXPIRACION = 1000 * 60 * 60; // 1 hora
const MAX_HISTORIAL = 10;

const ultimaActividad = new Map();
const TIEMPO_EXPIRACION_MAPS = 1000 * 60 * 60; // 1 hora

function registrarActividad(leadId) {
  ultimaActividad.set(leadId, Date.now());
}

setInterval(() => {
  const ahora = Date.now();
  for (const [hash, timestamp] of archivosProcesados.entries()) {
    if (ahora - timestamp > TIEMPO_EXPIRACION) {
      archivosProcesados.delete(hash);
    }
  };
}, 1000 * 60 * 10); // cada 10 minutos

// ===============================
// 🧹 LIMPIEZA AUTOMÁTICA DE LEADS INACTIVOS
// ===============================
setInterval(() => {
  const ahora = Date.now();

  for (const [leadId, timestamp] of ultimaActividad.entries()) {
    if (ahora - timestamp > TIEMPO_EXPIRACION_MAPS) {
      memoriaChat.delete(leadId);
      bufferMensajes.delete(leadId);
      registrosPendientes.delete(leadId);
      colasDeEspera.delete(leadId);
      ultimaActividad.delete(leadId);
    }
  }
}, 1000 * 60 * 15); // cada 15 minutos
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

async function buscarDesdeLeadFiles(leadId, config, kommoApi) {
  try {
    const { data } = await kommoApi.get(`/api/v4/leads/${leadId}/files`);
    const files = data._embedded?.files || [];
    console.log("📂 Archivos encontrados:", files.length);

    if (!files.length) return null;

    const fileUuid = files[0].file_uuid;

    const driveApiUrl = `https://drive-c.kommo.com/v1.0/files/${fileUuid}`;

    const { data: driveFile } = await axios.get(driveApiUrl, {
      headers: { Authorization: `Bearer ${config.KOMMO_LONG_TOKEN}` }
    });

    return driveFile._links?.download?.href;
  } catch {
    return null;
  }
}

async function buscarComprobante(leadId, config, kommoApi) {
  for (let i = 1; i <= 6; i++) {
    const url = await buscarDesdeLeadFiles(leadId, config, kommoApi);
    if (url) return url;
    await sleep(2000);
  }
  return null;
}

async function descargarImagen(url, leadId, config) {
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${config.KOMMO_LONG_TOKEN}` }
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

async function enviarDiscord(filePath, usuario, leadId, config) {
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

    await axios.post(config.DISCORD_WEBHOOK, form, {
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

function calcularBono(usuario, config) {

  const nuncaCargo =
    !usuario ||
    usuario.ultima_carga == null ||
    Number(usuario.ultima_carga) === 0;

  if (nuncaCargo) {
    return "200% por primera carga ❤️";
  }

  const hora = obtenerHoraArgentina();


 if (config.HORAS_100.includes(hora)) {
    return "100% activo, aprovechalo❤️";
  }

  return "50% bono del dia❤️";
}
/* ================= DETECTOR NOMBRE ================= */
async function detectarNombreIA(mensaje, openai) {

  const prompt = `
Analiza el mensaje del usuario.

Si el mensaje contiene un nombre propio que el usuario quiere usar como nombre de cuenta,
extrae SOLO el nombre limpio.

Reglas:
- Devuelve solo el primer nombre
- Sin frases adicionales
- Sin emojis
- Sin símbolos
- Primera letra mayúscula
- Máximo 15 caracteres
- Si no hay nombre claro, responde no_es_nombre

Responde SOLO JSON con este formato:

Si hay nombre:
{"resultado":"nombre_valido","nombre":"Juan"}

Si no hay nombre:
{"resultado":"no_es_nombre"}

Mensaje:
"${mensaje}"
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }]
  });

  return JSON.parse(completion.choices[0].message.content);
}
/* ================= DETECTOR INTELIGENTE ================= */
async function detectarAccionIA(mensaje, openai) {

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
async function procesarFlujoGPT(leadId, mensajeUnificado, config, kommoApi, openai, clienteId) {

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

    const usuarioExistente = await buscarUsuarioPorTelefono(telefono, clienteId);

/* ======================================================
   AUTO-REGISTRO SI ENVÍA NOMBRE DIRECTAMENTE
====================================================== */

if (!usuarioExistente) {

  const analisisNombreDirecto = await detectarNombreIA(mensajeUnificado, openai);

  if (analisisNombreDirecto?.resultado === "nombre_valido") {

    console.log("🆕 Nombre detectado sin contexto previo. Creando usuario...");

    const nombre = analisisNombreDirecto.nombre;

    const nuevoUsuario = await crearUsuarioEnDota({
  nombreBase: nombre,
  DOTA_DOMAIN: config.DOTA_DOMAIN,
  DOTA_USER: config.DOTA_USER,
  DOTA_PASS: config.DOTA_PASS,
  DOTA_USER_SUFFIX: config.DOTA_USER_SUFFIX
});

    if (!nuevoUsuario?.loginNuevo || !nuevoUsuario?.passDota) {

      await enviarMensajeYBot(
        leadId,
        "Hubo un problema creando tu usuario. Intentá nuevamente en unos segundos.", config, kommoApi
      );

      return;
    }

const nuevo = await guardarUsuario({
  telefono,
  nombre_usuario: nuevoUsuario.loginNuevo,
  clave: nuevoUsuario.passDota,
  cliente: clienteId
});

if (!nuevo) {
  console.log("Usuario ya existía, continuando flujo...");
}

    const mensajeBienvenida =
`Listo ${nombre}, ya está creado.
Usuario: ${nuevoUsuario.loginNuevo}
Clave: ${nuevoUsuario.passDota}`;

    await kommoApi.patch("/api/v4/leads", [
      {
        id: Number(leadId),
        name: nuevoUsuario.loginNuevo,
        custom_fields_values: [
          {
            field_id: Number(config.KOMMO_FIELD_ID_CLAVE),
            values: [{ value: nuevoUsuario.passDota }]
          },
          {
            field_id: Number(config.KOMMO_FIELD_ID_MENSAJEENVIAR),
            values: [{ value: mensajeBienvenida }]
          }
        ]
      }
    ]);

    await ejecutarSalesbot(
  leadId,
  config.KOMMO_SALESBOT_RESPUESTA,
  kommoApi
);
    await ejecutarSalesbot(leadId, config.KOMMO_SALESBOT_ID_PRIMERCBU, kommoApi);

    return;
  }
}

    /* ======================================================
       REGISTRO INTELIGENTE
    ====================================================== */

    if (!usuarioExistente && registrosPendientes.has(leadId)) {

      const analisis = await detectarNombreIA(mensajeUnificado, openai);

      if (analisis?.resultado === "nombre_valido") {

        const nombre = analisis.nombre;

        const nuevoUsuario = await crearUsuarioEnDota({
  nombreBase: nombre,
  DOTA_DOMAIN: config.DOTA_DOMAIN,
  DOTA_USER: config.DOTA_USER,
  DOTA_PASS: config.DOTA_PASS,
  DOTA_USER_SUFFIX: config.DOTA_USER_SUFFIX
});

        if (!nuevoUsuario?.loginNuevo || !nuevoUsuario?.passDota) {

          await enviarMensajeYBot(
            leadId,
            "Hubo un problema creando tu usuario. Intentá nuevamente en unos segundos.", config, kommoApi
          );

          return;
        }

const nuevo = await guardarUsuario({
  telefono,
  nombre_usuario: nuevoUsuario.loginNuevo,
  clave: nuevoUsuario.passDota,
  cliente: clienteId
});

if (!nuevo) {
  console.log("Usuario ya existía, continuando flujo...");
}

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
                field_id: Number(config.KOMMO_FIELD_ID_CLAVE),
                values: [{ value: nuevoUsuario.passDota }]
              },
              {
                field_id: Number(config.KOMMO_FIELD_ID_MENSAJEENVIAR),
                values: [{ value: mensajeBienvenida }]
              }
            ]
          }
        ]);

        await ejecutarSalesbot(leadId, config.KOMMO_SALESBOT_RESPUESTA, kommoApi);
        await ejecutarSalesbot(leadId, config.KOMMO_SALESBOT_ID_PRIMERCBU, kommoApi);

        return;
      }

      await enviarMensajeYBot(
        leadId,
        "Necesito tu nombre o apodo para poder registrarte.", config, kommoApi
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
  comunidad: () => ejecutarSalesbot(leadId, config.KOMMO_SALESBOT_ID_COMUNIDAD, kommoApi),
  recomendar: () => ejecutarSalesbot(leadId, config.KOMMO_SALESBOT_ID_RECOMENDAR, kommoApi),
  recomende: () => ejecutarSalesbot(leadId, config.KOMMO_SALESBOT_ID_RECOMENDE, kommoApi),
  retirar: () => ejecutarSalesbot(leadId, config.KOMMO_SALESBOT_ID_RETIRAR, kommoApi),
  gratis: () => ejecutarSalesbot(leadId, config.KOMMO_SALESBOT_ID_GRATIS, kommoApi),
  sorteo: () => ejecutarSalesbot(leadId, config.KOMMO_SALESBOT_ID_SORTEO, kommoApi),
  link: () => ejecutarSalesbot(leadId, config.KOMMO_SALESBOT_ID_LINK, kommoApi),
  wager: () => ejecutarSalesbot(leadId, config.KOMMO_SALESBOT_ID_WAGER, kommoApi),
  transfirio: () => ejecutarSalesbot(leadId, config.KOMMO_SALESBOT_ID_TRANSFIRIO, kommoApi),
  cbu: () => ejecutarSalesbot(leadId, config.KOMMO_SALESBOT_ID_CBU, kommoApi),
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

  await enviarMensajeYBot(leadId, respuestaIA, config, kommoApi);

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
/* ================= HELPERS ================= */
async function enviarMensajeYBot(leadId, mensaje, config, kommoApi) {
  await kommoApi.patch(`/api/v4/leads/${leadId}`, {
    custom_fields_values: [
      {
        field_id: Number(config.KOMMO_FIELD_ID_MENSAJEENVIAR),
        values: [{ value: mensaje }]
      }
    ]
  });

  await ejecutarSalesbot(leadId, config.KOMMO_SALESBOT_RESPUESTA, kommoApi);
}

async function ejecutarSalesbot(leadId, botId, kommoApi) {
  await kommoApi.post("/api/v2/salesbot/run", [
    {
      bot_id: Number(botId),
      entity_id: Number(leadId),
      entity_type: 2
    }
  ]);
}

/* ================= WEBHOOK ================= */

import { kommoClients } from "./config/kommoClients.js";

app.post("/webhook-kommo/:cliente", async (req, res) => {

  const clienteId = req.params.cliente;
  const config = kommoClients[clienteId];

  if (!config) {
    return res.status(404).send("Cliente no encontrado");
  }

  const kommoApi = axios.create({
    baseURL: `https://${config.SUBDOMAIN_KOMMO}.kommo.com`,
    headers: { Authorization: `Bearer ${config.KOMMO_LONG_TOKEN}` }
  });

axiosRetry(kommoApi, { retries: 3 });

if (!config.OPENAI_API_KEY) {
  console.error("Falta OPENAI_API_KEY para", clienteId);
  return res.sendStatus(500);
}

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY
});
  const leadId = getLeadId(req.body);
  if (!leadId) return res.sendStatus(200);
  registrarActividad(leadId);
  try {

    const { data: lead } = await kommoApi.get(
      `/api/v4/leads/${leadId}`
    );

    const mensajeCliente =
      lead.custom_fields_values?.find(
        f => f.field_id == config.KOMMO_FIELD_ID_MENSAJEENVIAR
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
        "No puedo recibir audios ni emojis, solo texto y capturas de comprobante porfis", config, kommoApi
      );
      return res.sendStatus(200);
    }

    let archivosDrive = [];

    // 🔎 Obtener info real desde Drive
    for (const file of files) {

      const driveApiUrl = `https://drive-c.kommo.com/v1.0/files/${file.file_uuid}`;

      const { data: driveFile } = await axios.get(driveApiUrl, {
        headers: { Authorization: `Bearer ${config.KOMMO_LONG_TOKEN}` }
      });

      archivosDrive.push(driveFile);
    }

    // 🔥 Ordenar por fecha (más reciente primero)
    archivosDrive.sort((a, b) => b.created_at - a.created_at);

    // 🔍 Buscar primera imagen válida
const imagenValida = archivosDrive.find(file => {

  if (file.type !== "image") return false;

  if (file.created_by?.type !== "external") return false;

  // validar antigüedad (10 min)
  const ahoraSeg = Math.floor(Date.now() / 1000);
  const diferenciaMinutos = (ahoraSeg - file.created_at) / 60;
  if (diferenciaMinutos > 10) return false;

  // evitar reprocesar (TTL)
  const timestamp = archivosProcesados.get(file.uuid);
  const ahoraMs = Date.now();

  if (timestamp && (ahoraMs - timestamp) < TIEMPO_EXPIRACION) {
    return false;
  }

  return true;
});
    if (!imagenValida) {
      await enviarMensajeYBot(
        leadId,
        "No puedo recibir audios ni emojis, solo texto y capturas de comprobante porfis", config, kommoApi
      );
      return res.sendStatus(200);
    }

    archivosProcesados.set(imagenValida.uuid, Date.now());

    const downloadUrl = imagenValida._links?.download?.href;

    if (!downloadUrl) return res.sendStatus(200);

    const filePath = await descargarImagen(downloadUrl, leadId, config);
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
        const usuarioDB = await buscarUsuarioPorTelefono(telefono, clienteId);
        if (usuarioDB) nombreUsuario = usuarioDB.nombre_usuario;
      // 🔒 Si no existe usuario aún, NO enviar a Discord
if (!usuarioDB) {

  await enviarMensajeYBot(
    leadId,
    "Genial, ahora solo queda crear tu usuario. Decime tu nombre así lo creo!", config, kommoApi
  );

  return res.sendStatus(200);
}
      }
    }

    await enviarDiscord(filePath, nombreUsuario, leadId, config);

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

      await procesarFlujoGPT(leadId, mensajeUnificado, config, kommoApi, openai, clienteId );

    }, 5000);

    colasDeEspera.set(leadId, timeoutId);

  } catch (error) {
    console.error("Error en webhook:", error.message);
  }

  res.sendStatus(200);
});

/* ================= WEBHOOK OCR (DESDE PYTHON) ================= */
app.post("/webhook-ocr/:cliente", async (req, res) => {

  const clienteId = req.params.cliente;
  const config = kommoClients[clienteId];

  if (!config) {
    return res.status(404).send("Cliente no encontrado");
  }

  const { lead_id, resultado, monto } = req.body;

  if (!lead_id || !resultado) {
    return res.sendStatus(400);
  }

const kommoApi = axios.create({
  baseURL: `https://${config.SUBDOMAIN_KOMMO}.kommo.com`,
  headers: { Authorization: `Bearer ${config.KOMMO_LONG_TOKEN}` }
});

axiosRetry(kommoApi, { retries: 3 });  

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

  const montoNumero = Number(
    String(monto)
      .replace(",", ".")
      .replace(/[^\d.]/g, "")
  );

  if (!isNaN(montoNumero)) {
    await actualizarUltimaCarga(telefono, montoNumero, clienteId);
    console.log("💾 Última carga actualizada:", telefono, montoNumero);
  }
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

    await enviarMensajeYBot(lead_id, mensaje, config, kommoApi);

    res.sendStatus(200);

  } catch (error) {

    console.error("❌ Error en webhook-ocr:", error.message);
    res.sendStatus(500);

  }

});
const PORT = process.env.PORT || 3000;
/* ================= FIN ================= */
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});

