import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function initDB() {
  console.log("Supabase conectado");
}

async function buscarUsuarioPorTelefono(telefono) {
  const { data, error } = await supabase
    .from("usuarios")
    .select("*")
    .eq("telefono", telefono)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("Error buscando usuario:", error);
    return null;
  }

  return data || null;
}

async function guardarUsuario(data) {
  const { error } = await supabase
    .from("usuarios")
    .insert([
      {
        telefono: data.telefono,
        nombre_usuario: data.nombre_usuario,
        user_id_dota: data.user_id_dota,
        clave: data.clave,
        titular: null,
        cuit: null,
        gmail: null
      }
    ]);

  if (error) {
    console.error("Error guardando usuario:", error);
  }
}

export {
  initDB,
  buscarUsuarioPorTelefono,
  guardarUsuario
};