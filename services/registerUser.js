import { crearUsuarioEnDota } from "./dotaService.js";
import {guardarUsuario} from "./dbService.js";
import { enviarMensajeYBot, ejecutarSalesbot } from "./kommoBotService.js";

export async function registrarUsuario({
  leadId,
  nombre,
  telefono,
  clienteId,
  config,
  kommoApi
}) {

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
      "Hubo un problema creando tu usuario. Intentá nuevamente en unos segundos.",
      config,
      kommoApi
    );
    return null;
  }

  await guardarUsuario({
    telefono,
    nombre_usuario: nuevoUsuario.loginNuevo,
    clave: nuevoUsuario.passDota,
    cliente: clienteId
  });

  const mensajeBienvenida = `Listo ${nombre}, ya está creado.
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

  await ejecutarSalesbot(
    leadId,
    config.KOMMO_SALESBOT_ID_PRIMERCBU,
    kommoApi
  );

  return nuevoUsuario;
}