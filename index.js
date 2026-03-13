import express from "express";
import axios from "axios";
import axiosRetry from "axios-retry";
import dotenv from "dotenv";
import OpenAI from "openai";
import { crearUsuarioEnDota } from "./services/dotaService.js";
import { kommoClients } from "./config/kommoClients.js";
import {buscarUsuarioPorTelefono,guardarUsuario,actualizarUltimaCarga} from "./services/dbService.js";
import {getLeadId,obtenerTelefono} from "./utils/utilsGenerales.js";
import {colasDeEspera,bufferMensajes,archivosProcesados,registrarActividad,TIEMPO_EXPIRACION} from "./services/chatMemory.js";
import { descargarImagen, enviarDiscord } from "./services/fileService.js";
import { enviarMensajeYBot, ejecutarSalesbot } from "./services/kommoBotService.js";
import { procesarFlujoGPT } from "./services/chatFlowService.js";
import { buscarUsuarioEnKommoPorTelefono } from "./services/syncKommoUser.js";
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* ================= WEBHOOK ================= */
app.post("/webhook-kommo/:cliente", async (req, res) => {
  const clienteId = req.params.cliente;
  const config = kommoClients[clienteId];
  if (!config) {
    return res.status(404).send("Cliente no encontrado");
  }
  const kommoApi = crearKommoApi(config);
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
  // 🔥 1. Debe tener link de descarga
  if (!file._links?.download?.href) return false;
  // 🔥 2. Validar que sea imagen por MIME (más confiable)
  const mime = file.metadata?.mime_type || "";
  if (!mime.startsWith("image/")) return false;
  // 🔥 3. Validar antigüedad (10 min)
  const ahoraSeg = Math.floor(Date.now() / 1000);
  const diferenciaMinutos = (ahoraSeg - file.created_at) / 60;
  if (diferenciaMinutos > 10) return false;
  // 🔥 4. Evitar reprocesar
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
      const telefono = obtenerTelefono(contacto);
      if (telefono) {
let usuarioDB = await buscarUsuarioPorTelefono(telefono, clienteId);

if (!usuarioDB) {

  console.log("🔎 Usuario no encontrado en DB, buscando en Kommo...");

try {
  const usuarioKommo = await buscarUsuarioEnKommoPorTelefono(
    telefono,
    config,
    kommoApi
  );
  if (!usuarioKommo) {
    console.log("ℹ️ No existe usuario válido en Kommo");
  } else {
    console.log("🔄 Usuario encontrado en Kommo, sincronizando...");
    await guardarUsuario({
      telefono,
      nombre_usuario: usuarioKommo.nombre_usuario,
      clave: usuarioKommo.clave,
      cliente: clienteId
    });
    // actualizar variable
    usuarioDB = usuarioKommo;
  }

} catch (e) {

  console.log("⚠️ Error buscando usuario en Kommo:", e.message);

}
}

// 🔒 Si todavía no existe
if (!usuarioDB) {

  await enviarMensajeYBot(
    leadId,
    "Genial, ahora solo queda crear tu usuario. Decime tu nombre así lo creo!",
    config,
    kommoApi
  );

  return res.sendStatus(200);

}

nombreUsuario = usuarioDB.nombre_usuario;
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
function crearKommoApi(config) {
  const api = axios.create({
    baseURL: `https://${config.SUBDOMAIN_KOMMO}.kommo.com`,
    headers: { Authorization: `Bearer ${config.KOMMO_LONG_TOKEN}` }
  });
  axiosRetry(api, { retries: 3 });
  return api;
}
/* ================= crear usuario manual kommo ================= */  
app.post("/crear-usuario/:cliente", async (req, res) => {

  const clienteId = req.params.cliente;
  const config = kommoClients[clienteId];

  if (!config) {
    return res.status(404).json({ error: "Cliente no encontrado" });
  }

const lead_id = getLeadId(req.body);

if (!lead_id) {
  console.log("❌ crear-usuario: No llegó leadId", req.body);
  return res.status(400).json({ error: "No llegó lead_id" });
}

  const kommoApi = crearKommoApi(config);

  try {

    /* ===============================
       1️⃣ OBTENER LEAD + CONTACTO
    =============================== */

    const { data: lead } = await kommoApi.get(
      `/api/v4/leads/${lead_id}`,
      { params: { with: "contacts" } }
    );

    const nombreBase = lead.name || "Usuario";

    const contactoId = lead._embedded?.contacts?.[0]?.id;

    if (!contactoId) {
      return res.status(400).json({ error: "Lead sin contacto asociado" });
    }

    const { data: contacto } = await kommoApi.get(
      `/api/v4/contacts/${contactoId}`
    );

    const telefono = obtenerTelefono(contacto);

    if (!telefono) {
      return res.status(400).json({ error: "Contacto sin teléfono válido" });
    }

    /* ===============================
       2️⃣ VERIFICAR SI YA EXISTE
    =============================== */

    const usuarioExistente = await buscarUsuarioPorTelefono(
      telefono,
      clienteId
    );

    if (usuarioExistente) {

      const mensajeBienvenida =
`Ya tenes usuario, tus accesos:
Usuario: ${usuarioExistente.nombre_usuario}
Clave: ${usuarioExistente.clave}`;

      await kommoApi.patch("/api/v4/leads", [
        {
          id: Number(lead_id),
          custom_fields_values: [
            {
              field_id: Number(config.KOMMO_FIELD_ID_MENSAJEENVIAR),
              values: [{ value: mensajeBienvenida }]
            }
          ]
        }
      ]);

      await ejecutarSalesbot(lead_id, config.KOMMO_SALESBOT_RESPUESTA, kommoApi);

      return res.json({
        status: "ya_existia"
      });
    }

    /* ===============================
       3️⃣ CREAR USUARIO EN DOTA
    =============================== */

    const nuevoUsuario = await crearUsuarioEnDota({
      nombreBase,
      DOTA_DOMAIN: config.DOTA_DOMAIN,
      DOTA_USER: config.DOTA_USER,
      DOTA_PASS: config.DOTA_PASS,
      DOTA_USER_SUFFIX: config.DOTA_USER_SUFFIX
    });

    if (!nuevoUsuario?.loginNuevo || !nuevoUsuario?.passDota) {
      return res.status(500).json({
        error: "No se pudo crear usuario en Dota"
      });
    }

    /* ===============================
       4️⃣ GUARDAR EN DB (MISMA LÓGICA)
    =============================== */

    const nuevo = await guardarUsuario({
      telefono,
      nombre_usuario: nuevoUsuario.loginNuevo,
      clave: nuevoUsuario.passDota,
      cliente: clienteId
    });

    if (!nuevo) {
      console.log("Usuario ya existía, continuando flujo...");
    }

    /* ===============================
       5️⃣ ARMAR MENSAJE BIENVENIDA
    =============================== */

    const mensajeBienvenida =
`Listo ${nombreBase}, ya está listo.
Usuario: ${nuevoUsuario.loginNuevo}
Clave: ${nuevoUsuario.passDota}`;

    /* ===============================
       6️⃣ ACTUALIZAR LEAD
    =============================== */

    await kommoApi.patch("/api/v4/leads", [
      {
        id: Number(lead_id),
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

    /* ===============================
       7️⃣ EJECUTAR SALESBOTS
    =============================== */

    await ejecutarSalesbot(
      lead_id,
      config.KOMMO_SALESBOT_RESPUESTA,
      kommoApi
    );

    await ejecutarSalesbot(
      lead_id,
      config.KOMMO_SALESBOT_ID_PRIMERCBU,
      kommoApi
    );

    return res.json({
      status: "success"
    });

  } catch (error) {

    console.error("❌ Error crear-usuario:", error.message);

    return res.status(500).json({
      error: "Error interno",
      detalle: error.message
    });
  }
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

const kommoApi = crearKommoApi(config);

  console.log("📡 Resultado OCR recibido:", lead_id, resultado);

  try {

    let mensaje = "";

    switch (resultado) {

case "exito":

  mensaje = "Tu carga fue acreditada ❤️\nSi recomendas a un amigo obtenes 6mil por cada uno\nPor 5 amigos 6mil adicionales (36mil en Total)";

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

      const telefono = obtenerTelefono(contacto);

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
        mensaje = "Este comprobante ya fue enviado anteriormente. Si crees que es un error escribi: SOPORTE.";
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
        mensaje = "Hubo un problema procesando tu comprobante. Envialo nuevamente.";
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