import fs from "fs";
import path from "path";
import axios from "axios";
import FormData from "form-data";

const DOWNLOAD_DIR = path.join(process.cwd(), "comprobantes");
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

async function descargarImagen(url, leadId, config) {
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${config.KOMMO_LONG_TOKEN}` }
    });

    const filePath = path.join(
      DOWNLOAD_DIR,
      `lead_${leadId}_${Date.now()}.jpg`
    );

    await fs.promises.writeFile(filePath, response.data);
    return filePath;
  } catch (err) {
    console.log("❌ Error descargando imagen:", err.message);
    return null;
  }
}

async function enviarDiscord(filePath, usuario, leadId, config) {
  try {
    const form = new FormData();

    form.append(
      "payload_json",
      JSON.stringify({
        content:
`🤵 Usuario: **${usuario}**
🆔 LeadID: ${leadId}`
      })
    );

    form.append("file", fs.createReadStream(filePath));

    await axios.post(config.DISCORD_WEBHOOK, form, {
      headers: form.getHeaders()
    });

    console.log("✅ Enviado a Discord");

    fs.unlink(filePath, err => {
      if (err) console.log("⚠️ No se pudo borrar archivo:", err.message);
    });

  } catch (err) {
    console.log("❌ Error enviando a Discord:", err.message);
  }
}

export {
  descargarImagen,
  enviarDiscord
};
