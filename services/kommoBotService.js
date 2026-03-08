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
};
export{
    enviarMensajeYBot,
    ejecutarSalesbot
}