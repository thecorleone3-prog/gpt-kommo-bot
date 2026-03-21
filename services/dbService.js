import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  throw new Error("❌ Faltan variables de entorno de Supabase");
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function buscarUsuarioPorTelefono(telefono, cliente) {
  const { data, error } = await supabase
    .from("usuarios")
    .select("*")
    .eq("telefono", telefono)
    .eq("cliente", cliente)
    .maybeSingle(); 

  if (error) {
    console.error("Error buscando usuario:", error.message);
    throw error;
  }

  return data || null;
}


async function guardarUsuario(data) {
  const { data: inserted, error } = await supabase
    .from("usuarios")
    .upsert(
      [
        {
          telefono: data.telefono,
          nombre_usuario: data.nombre_usuario.toLowerCase().trim(),
          user_id_dota: data.user_id_dota || null,
          clave: data.clave,
          cliente: data.cliente,
          lead_id: data.lead_id || null,
          titular: null,
          cuit: null,
          gmail: null
        }
      ],
      {
        onConflict: "telefono,cliente" // 🔥 CLAVE
      }
    )
    .select()
    .single();

  if (error) {
    console.error("Error guardando usuario:", error.message);
    throw error;
  }

  return inserted;
}

/* ============================= */
/*    ACTUALIZAR ÚLTIMA CARGA    */
/* ============================= */
/*
  🔥 Ahora también filtra por cliente
*/
async function actualizarUltimaCarga(telefono, monto, cliente) {
  const { error } = await supabase
    .from("usuarios")
    .update({
      ultima_carga: monto,
      ultima_carga_fecha: new Date().toISOString()
    })
    .eq("telefono", telefono)
    .eq("cliente", cliente);

  if (error) {
    console.error("Error actualizando última carga:", error.message);
    throw error;
  }
}

async function actualizarLeadId(telefono, cliente, leadId) {
  const { error } = await supabase
    .from("usuarios")
    .update({
      lead_id: leadId,
      updated_at: new Date().toISOString()
    })
    .eq("telefono", telefono)
    .eq("cliente", cliente);

  if (error) {
    console.error("Error actualizando lead_id:", error.message);
    throw error;
  }
}
  async function buscarUsuarioPorUsername(username, cliente) {
  const { data, error } = await supabase
    .from("usuarios")
    .select("*")
    .eq("nombre_usuario", username.toLowerCase().trim()) // 🔥 clave
    .eq("cliente", cliente)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export {
  buscarUsuarioPorTelefono,
  guardarUsuario,
  actualizarUltimaCarga,
  actualizarLeadId,
  buscarUsuarioPorUsername
};