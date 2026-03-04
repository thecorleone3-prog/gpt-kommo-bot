import axios from "axios";

/* ================= UTIL ================= */

function normalizarNombre(nombre) {
  return nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "");
}

/* ================= FUNCIÓN EXPORTADA ================= */

export async function crearUsuarioEnDota({
  nombreBase,
  DOTA_DOMAIN,
  DOTA_USER,
  DOTA_PASS,
  DOTA_USER_SUFFIX
}) {
  try {
    if (!DOTA_DOMAIN || !DOTA_USER || !DOTA_PASS) {
      throw new Error("Configuración Dota incompleta");
    }

    const loginNuevo = `${normalizarNombre(nombreBase)}${Math.floor(
      100 + Math.random() * 900
    )}${DOTA_USER_SUFFIX}`;

    const passDota = Math.floor(
      1000 + Math.random() * 9000
    ).toString();

    // 🔐 Login admin
    const loginRes = await axios.post(
      `https://${DOTA_DOMAIN}/index.php?act=admin&area=login`,
      new URLSearchParams({
        login: DOTA_USER,
        password: DOTA_PASS,
        send: "Login"
      }),
      {
        timeout: 10000,
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400
      }
    );

    const cookies = loginRes.headers["set-cookie"]
      ?.map((c) => c.split(";")[0])
      .join("; ");

    if (!cookies) {
      throw new Error("No se pudo loguear en Dota");
    }

    // 👤 Crear usuario
    const createRes = await axios.post(
      `https://${DOTA_DOMAIN}/index.php?act=admin&area=createuser`,
      new URLSearchParams({
        group: "5",
        sended: "true",
        email: "",
        login: loginNuevo,
        password: passDota,
        balance: ""
      }),
      {
        timeout: 10000,
        headers: { Cookie: cookies }
      }
    );

    if (
      createRes.data.includes("Exito") ||
      createRes.data.includes(loginNuevo)
    ) {
      return { loginNuevo, passDota };
    }

    throw new Error("Dota no confirmó creación");
  } catch (error) {
    console.error("❌ Error Dota:", error.message);
    return null;
  }
}