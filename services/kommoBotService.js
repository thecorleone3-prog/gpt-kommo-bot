async function enviarMensajeYBot(leadId, mensaje, config, kommoApi) {
  await kommoApi.patch(`/api/v4/leads/${leadId}`, {
    custom_fields_values: [
      {
        field_id: Number(config.KOMMO_FIELD_ID_MENSAJEENVIAR),
        values: [{ value: mensaje }]
      }
    ]
  });
  await new Promise(r => setTimeout(r, 1100));
  const botId = Number(config.KOMMO_SALESBOT_RESPUESTA);
  if (!botId) {
    console.log("Bot ID inválido");
    return;
  }
  try{
    await kommoApi.post("/api/v2/salesbot/run", [
      {
        bot_id: botId,
        entity_id: Number(leadId),
        entity_type: 2
      }
    ]);
  }catch(e){
    console.log("Error ejecutando bot:", e.response?.data || e.message);
  }
}
async function ejecutarSalesbot(leadId, botId, kommoApi) {
  try{
    await kommoApi.post("/api/v2/salesbot/run", [
      {
        bot_id: Number(botId),
        entity_id: Number(leadId),
        entity_type: 2
      }
    ]);
  }catch(e){
    console.log("Error ejecutando salesbot:", e.response?.data || e.message);
  }
}
export {
  enviarMensajeYBot,
  ejecutarSalesbot
};