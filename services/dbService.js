import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

/* ============================= */
/*   VALIDACIÓN DE VARIABLES     */
/* ============================= */

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  throw new Error("❌ Faltan variables de entorno de Supabase");
}

/* ============================= */
/*      CLIENTE SUPABASE         */
/* ============================= */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/* ============================= */
/*     BUSCAR USUARIO            */
/* ============================= */
/*
  🔥 Ahora requiere cliente (tenant_id)
*/
async function buscarUsuarioPorTelefono(telefono, cliente) {
  const { data, error } = await supabase
    .from("usuarios")
    .select("*")
    .eq("telefono", telefono)
    .eq("cliente", cliente)
    .maybeSingle(); // mejor que single() para evitar error si no existe

  if (error) {
    console.error("Error buscando usuario:", error.message);
    throw error;
  }

  return data || null;
}

/* ============================= */
/*      GUARDAR USUARIO          */
/* ============================= */
/*
  🔥 Requiere cliente
*/
async function guardarUsuario(data) {
  const { data: inserted, error } = await supabase
    .from("usuarios")
    .insert([
      {
        telefono: data.telefono,
        nombre_usuario: data.nombre_usuario,
        user_id_dota: data.user_id_dota || null,
        clave: data.clave,
        cliente: data.cliente,
        titular: null,
        cuit: null,
        gmail: null
      }
    ])
    .select()
    .single();

  if (error) {
    // 🔥 Manejo específico duplicado
    if (error.code === "23505") {
      console.log("⚠ Usuario ya existe para este cliente");
      return null;
    }

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

/* ============================= */
/*           EXPORTS             */
/* ============================= */

export {
  buscarUsuarioPorTelefono,
  guardarUsuario,
  actualizarUltimaCarga
};