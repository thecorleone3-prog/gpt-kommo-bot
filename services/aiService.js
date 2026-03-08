/* ================= DETECTOR NOMBRE ================= */
async function detectarNombreIA(mensaje, openai) {

  const prompt = `
Analiza el mensaje del usuario.

Si el mensaje contiene un nombre propio que el usuario quiere usar como nombre de cuenta,
extrae SOLO el nombre limpio.

Reglas:
- Devuelve solo el primer nombre
- Sin frases adicionales
- Sin emojis
- Sin símbolos
- Primera letra mayúscula
- Máximo 15 caracteres
- Si no hay nombre claro, responde no_es_nombre

Responde SOLO JSON con este formato:

Si hay nombre:
{"resultado":"nombre_valido","nombre":"Juan"}

Si no hay nombre:
{"resultado":"no_es_nombre"}

Mensaje:
"${mensaje}"
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }]
  });

  return JSON.parse(completion.choices[0].message.content);
}
/* ================= DETECTOR INTELIGENTE ================= */
async function detectarAccionIA(mensaje, openai) {

  const prompt = `
Analiza el mensaje del cliente y responde SOLO JSON.

Tu tarea es clasificar el mensaje en UNA de estas acciones:

- saludo → saludos simples (hola, buenas, etc.)
- bono → preguntas sobre bonos o beneficios
- accesos → quiere entrar, acceder, usuario, clave, cuenta
- comunidad → pide grupo, comunidad, trivia, juegos ganadores 
- cbu → pide datos de pago, cuenta, cbu, transferencia, donde cargo, cargar o fichas
- transfirio → ya trasnfirio, ya pago, ya envio su pago, ya cargó, ya mandó
- recomendar → quiere invitar, referir, recomendar, como recomiendo?
- recomende → ya refirio, invito, recomendo, te mandé uno
- gratis → quiere gratis, fichas de regalo, dan fichas para probar, como gano fichas gratis
- retirar → quiere retirar, cobrar premio, retirar saldo, bajar fichas, gene un premio, como retiro
- sorteo → sorteo, como participo del sorteo, gane el sorteo, donde se sortea, ya sortearon?
- link → link de la plataforma, plataforma, pasame el link para jugar, donde juego?
- wager → que juegos aceptan bono?, cuales juego puedo jugar con bono?, como uso el bono?
- soporte → problemas, errores, reclamos, pagos no acreditados, bloqueos, o necesita ayuda humana
- conversacion → agradecimientos, respuestas triviales o conversación sin intención clara

Reglas obligatorias:

- Si el usuario reporta un problema, error, pago no acreditado, bloqueo o reclamo → soporte
- Si el usuario necesita ayuda humana → soporte
- Si el mensaje es trivial como "gracias", "ok", "perfecto", etc. → conversacion
- Si el mensaje tiene intención clara de alguna acción específica → usar esa acción
- Si hay duda entre conversacion y soporte, prioriza soporte si hay un problema

Mensaje del cliente:
"${mensaje}"

Responde SOLO este formato JSON:
{"accion":"tipo"}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0, // importante para clasificación consistente
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Eres un clasificador de intenciones. Responde únicamente JSON válido."
      },
      {
        role: "user",
        content: prompt
      }
    ]
  });

  return JSON.parse(completion.choices[0].message.content);
};
export{
    detectarNombreIA,
    detectarAccionIA
}