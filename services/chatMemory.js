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
const cacheLeadData = new Map();
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
setInterval(() => {
  const ahora = Date.now();

  for (const [leadId, timestamp] of ultimaActividad.entries()) {
    if (ahora - timestamp > TIEMPO_EXPIRACION_MAPS) {
      memoriaChat.delete(leadId);
      bufferMensajes.delete(leadId);
      registrosPendientes.delete(leadId);
      colasDeEspera.delete(leadId);
      cacheLeadData.delete(leadId);
      ultimaActividad.delete(leadId);
    }
  }
}, 1000 * 60 * 15); // cada 15 minutos
function gestionarMemoria(leadId, nuevoMensaje) {
  const historial = memoriaChat.get(leadId) || [];
  if (nuevoMensaje) {
    historial.push(nuevoMensaje);
    if (historial.length > MAX_HISTORIAL) {
      historial.shift();
    }
    memoriaChat.set(leadId, historial);
  }
  return historial; 
};
export {
  memoriaChat,
  colasDeEspera,
  bufferMensajes,
  registrosPendientes,
  archivosProcesados,
  ultimaActividad,
  registrarActividad,
  gestionarMemoria,
  TIEMPO_EXPIRACION,
  cacheLeadData
};

