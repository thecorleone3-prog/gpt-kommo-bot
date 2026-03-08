export async function buscarUsuarioEnKommoPorTelefono(
  telefono,
  config,
  kommoApi
) {
  try {

    const { data } = await kommoApi.get("/api/v4/leads", {
      params: {
        query: telefono,
        with: "contacts"
      }
    });

    const leads = data._embedded?.leads || [];

    if (!leads.length) return null;

    let mejorLead = null;

    for (const lead of leads) {

      // filtro obligatorio por nombre
      if (!lead.name || !lead.name.toLowerCase().includes("dota")) continue;

      const fields = lead.custom_fields_values || [];

      const clave = fields.find(
        f => f.field_id == config.KOMMO_FIELD_ID_CLAVE
      )?.values?.[0]?.value;

      if (!mejorLead || lead.created_at > mejorLead.created_at) {
        mejorLead = lead;
      }

    }

    if (!mejorLead) return null;

    const clave =
      mejorLead.custom_fields_values?.find(
        f => f.field_id == config.KOMMO_FIELD_ID_CLAVE
      )?.values?.[0]?.value;

    return {
      nombre_usuario: mejorLead.name,
      clave
    };

  } catch (err) {

    console.log("❌ Error buscando usuario en Kommo:", err.message);

    return null;

  }
}