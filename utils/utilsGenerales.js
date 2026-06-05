/* ================= UTIL ================= */
export function getLeadId(body) {
  const id =
    body?.leads?.status?.[0]?.id ||
    body?.leads?.add?.[0]?.id ||
    body?.leads?.update?.[0]?.id ||
    body?.lead_id ||
    null;
  return id != null ? String(id) : null;
}

export function logError(prefijo, err) {
  const partes = [
    err?.message,
    err?.code,
    err?.response?.status != null ? `HTTP ${err.response.status}` : null,
    typeof err?.response?.data === "string"
      ? err.response.data
      : err?.response?.data
        ? JSON.stringify(err.response.data)
        : null
  ].filter(Boolean);

  console.error(prefijo, partes.length ? partes.join(" | ") : err);
}

export function normalizarTelefono(tel) {
  return tel?.replace(/\D/g, "") || null;
}

export function obtenerTelefono(contacto){
  const telefonoRaw = contacto.custom_fields_values?.find(
    f => f.field_code === "PHONE"
  )?.values?.[0]?.value;

  return normalizarTelefono(telefonoRaw);
}

export function obtenerHoraArgentina() {
  const ahora = new Date();

  const argentina = new Date(
    ahora.toLocaleString("en-US", {
      timeZone: "America/Argentina/Buenos_Aires"
    })
  );

  return argentina.getHours();
}

export function saludoCompleto(usuarioExistente) {

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

  return `${saludo} ${nombre}, como te ayudo?`;
}

export function calcularBono(usuario, config) {

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