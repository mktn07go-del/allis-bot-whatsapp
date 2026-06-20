// bot.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, addDoc } = require('firebase/firestore');

// ==========================================
// 1. CONFIGURACIÓN DE FIREBASE
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyCZAIBta0PhH7nvR9hav57ZW_CiDPuRMNg",
  authDomain: "promos-allis.firebaseapp.com",
  projectId: "promos-allis",
  storageBucket: "promos-allis.firebasestorage.app",
  messagingSenderId: "331737470259",
  appId: "1:331737470259:web:b856536ca16dab8355da46"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ==========================================
// 2. MEMORIA Y CATÁLOGOS
// ==========================================
const sesiones = {}; 
let catalogoCache = [];
let categoriasCache = [];
let SALSAS = [];
let PAPAS = [];
let ADEREZOS = [];

const ORDEN_CATEGORIAS = ["Alitas", "Boneless", "Combos", "Especiales", "Acompañamientos", "Bebidas"];

const obtenerSesion = (telefono) => {
    if (!sesiones[telefono]) {
        sesiones[telefono] = { 
            paso: 'INICIO', nombre: '', carrito: [], 
            categoriaSeleccionada: '', productosFiltrados: [],
            productoTemporal: null, opcionesTemp: {}, 
            tipoEntrega: '', direccion: '', metodoPago: '', errores: 0
        };
    }
    return sesiones[telefono];
};

const limpiarSesion = (telefono) => { delete sesiones[telefono]; };

const manejarError = (sesion, message, textoAyuda) => {
    sesion.errores += 1;
    if (sesion.errores >= 2) {
        message.reply("Parece que estamos teniendo problemas para entendernos. 😅\n\nUno de nuestros colaboradores leerá este chat y se pondrá en contacto contigo en breve para tomar tu pedido personalmente. 🧑‍💻");
        limpiarSesion(message.from);
    } else {
        message.reply(`⚠️ Opción inválida. ${textoAyuda}`);
    }
};

const cargarDatosFirebase = async () => {
    try {
        console.log("Cargando base de datos...");
        const snapProd = await getDocs(collection(db, "productos"));
        let tempProd = [];
        let catSet = new Set();
        snapProd.forEach(doc => {
            const data = doc.data();
            if (data.disponible !== false) {
                tempProd.push({ id: doc.id, ...data });
                if (data.categoria) catSet.add(data.categoria.trim());
            }
        });
        catalogoCache = tempProd;
        
        let categoriasDesordenadas = Array.from(catSet);
        categoriasCache = categoriasDesordenadas.sort((a, b) => {
            let indexA = ORDEN_CATEGORIAS.findIndex(c => c.toLowerCase() === a.toLowerCase());
            let indexB = ORDEN_CATEGORIAS.findIndex(c => c.toLowerCase() === b.toLowerCase());
            if (indexA === -1) indexA = 999;
            if (indexB === -1) indexB = 999;
            return indexA - indexB;
        });

        SALSAS = []; PAPAS = []; ADEREZOS = [];
        try {
            const snapComp = await getDocs(collection(db, "complementos"));
            snapComp.forEach(doc => {
                const data = doc.data();
                if (data.disponible !== false) {
                    const tipo = (data.tipo || '').toLowerCase();
                    // Leer la columna picor y crear emojis
                    const picorNum = parseInt(data.picor) || 0;
                    const picorStr = picorNum > 0 ? ' 🌶️'.repeat(picorNum) : '';
                    const nombreConPicor = data.nombre + picorStr;

                    if (tipo.includes('salsa')) SALSAS.push(nombreConPicor);
                    else if (tipo.includes('papa')) PAPAS.push(nombreConPicor);
                    else if (tipo.includes('aderezo')) ADEREZOS.push(nombreConPicor);
                }
            });
        } catch(e) {}
        console.log(`✅ Catálogo listo: ${catalogoCache.length} productos.`);
    } catch (e) { console.error("Error al cargar datos:", e); }
};

// ==========================================
// 3. MOTOR CONDICIONAL INTELIGENTE
// ==========================================
const avanzarPersonalizacion = (sesion, message) => {
    sesion.errores = 0; 
    const p = sesion.productoTemporal;
    const op = sesion.opcionesTemp;

    const esBebida = p.categoria && p.categoria.toLowerCase().includes('bebida');

    if (p.requiereProteina && !op.proteina) {
        sesion.paso = 'ELIGIENDO_PROTEINA';
        return message.reply("¿Qué proteína prefieres para este producto?\n\n*1.* Alitas\n*2.* Boneless\n*3.* Mitad y Mitad");
    }

    if (Array.isArray(p.variantes) && p.variantes.length > 0 && !op.variante) {
        let msg = "¿Qué *tamaño* deseas?\n\n";
        p.variantes.forEach((v, i) => msg += `*${i + 1}.* ${v.nombre} ($${v.precio})\n`);
        sesion.paso = 'ELIGIENDO_VARIANTE';
        return message.reply(msg);
    }

    if (!esBebida && (p.salsasMax || 0) > 0) {
        if (!op.cantidadSalsas && p.salsasMax > 1) {
            let msg = `Este producto te permite elegir hasta *${p.salsasMax} salsas*.\n¿Cuántas salsas diferentes deseas?\n\n`;
            for(let i = 1; i <= p.salsasMax; i++) {
                msg += `*${i}.* ${i === 1 ? 'Toda mi orden con 1 sola salsa' : 'Quiero ' + i + ' salsas diferentes'}\n`;
            }
            sesion.paso = 'ELIGIENDO_CANTIDAD_SALSAS';
            return message.reply(msg);
        }

        let maxElegir = op.cantidadSalsas || 1;
        if (!op.salsasElegidas) op.salsasElegidas = [];

        if (op.salsasElegidas.length < maxElegir) {
            let numSalsaActual = op.salsasElegidas.length + 1;
            let msg = "¿Qué *salsa* prefieres?\n\n";
            
            // Texto adaptado para Mitad y Mitad
            if (op.proteina === 'Mitad y Mitad') {
                msg = numSalsaActual === 1 
                    ? "¿Qué salsa quieres para la *PRIMERA MITAD (Alitas)*?\n\n"
                    : "¿Qué salsa quieres para la *SEGUNDA MITAD (Boneless)*?\n\n";
            } else if (maxElegir > 1) {
                msg = `¿Qué salsa quieres para tu *OPCIÓN ${numSalsaActual}*?\n\n`;
            }
            
            SALSAS.forEach((s, i) => msg += `*${i + 1}.* ${s}\n`);
            sesion.paso = 'ELIGIENDO_SALSA_MULTI';
            return message.reply(msg);
        }
    }

    if (!esBebida && (p.SaborPapasmax || 0) > 0 && !op.papa) {
        let msg = "¿Qué *sabor* quieres para tus papas?\n\n";
        PAPAS.forEach((p, i) => msg += `*${i + 1}.* ${p}\n`);
        sesion.paso = 'ELIGIENDO_PAPA';
        return message.reply(msg);
    }

    if (!esBebida && (p.aderezoMax || 0) > 0 && !op.aderezo) {
        let msg = "¿Deseas agregar algún *aderezo*?\n\n";
        ADEREZOS.forEach((a, i) => msg += `*${i + 1}.* ${a}\n`);
        sesion.paso = 'ELIGIENDO_ADEREZO';
        return message.reply(msg);
    }

    const varSel = op.variante;
    const precioFinal = varSel ? varSel.precio : ((p.precioDescuento || 0) > 0 ? p.precioDescuento : p.precio);
    
    let stringSalsas = (op.salsasElegidas && op.salsasElegidas.length > 0) ? op.salsasElegidas.join(' y ') : null;
    let cantFinal = op.cantidad || 1; // Toma la cantidad si se eligió bebida

    sesion.carrito.push({
        idCarrito: Date.now(), idProducto: p.id, nombre: p.nombre,
        precioUnitario: precioFinal, cantidad: cantFinal, precioTotal: precioFinal * cantFinal,
        variante: varSel ? varSel.nombre : null,
        proteina: op.proteina || null, salsas: stringSalsas,
        aderezos: op.aderezo || null, saborPapas: op.papa || null,
        envasadoAparte: false
    });

    sesion.productoTemporal = null;
    sesion.opcionesTemp = {};
    sesion.paso = 'CONFIRMANDO_CARRITO';
    message.reply("✅ Producto agregado a tu orden.\n\n¿Deseas agregar algo más?\n\n*1.* ➕ Sí, agregar otro producto\n*2.* 🛒 No, terminar y pagar");
};

// ==========================================
// 4. INICIALIZACIÓN DEL BOT
// ==========================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
client.on('ready', async () => {
    console.log('✅ BOT LISTO.');
    await cargarDatosFirebase();
});

// ==========================================
// 5. MÁQUINA DE ESTADOS (WHATSAPP)
// ==========================================
const parsearOpcion = (texto, arrayOpciones) => {
    let index = parseInt(texto) - 1;
    if (isNaN(index)) {
        index = arrayOpciones.findIndex(opt => opt.toLowerCase() === texto.toLowerCase());
    }
    return index;
};

// Función para verificar si el restaurante está abierto
const estaAbierto = () => {
    const ahora = new Date();
    const dia = ahora.getDay(); // 0=Dom, 1=Lun, ..., 3=Mie
    const hora = ahora.getHours();
    
    // Si elegiste Horario B (Abierto 24/7)
    // return true; 

    // Lógica para Horario A: Mié(3) a Dom(0) de 15:00 a 22:00
    if (dia === 1 || dia === 2) return false; // Lunes y Martes cerrado
    if (hora >= 15 && hora < 22) return true;
    
    return false;
};

client.on('message', async (message) => {
    // NUEVA VALIDACIÓN DE HORARIO
    if (!estaAbierto()) {
        message.reply("👋 ¡Hola! Gracias por escribir a Alli's Restaurante.\n\nActualmente estamos cerrados. Nuestro horario de atención es de Miércoles a Domingo de 3:00 PM a 10:00 PM. 🕒\n\nDéjanos tu pedido y un colaborador te atenderá en cuanto abramos. 🍔");
        return; // El bot no sigue procesando nada más
    }

    const sesion = obtenerSesion(telefono);
    const op = sesion.opcionesTemp;

    try {
        switch (sesion.paso) {
            case 'ESPERANDO_NOMBRE':
                sesion.nombre = texto;
                message.reply(`¡Un gusto, ${sesion.nombre}! 👨‍🍳\n\n¿Qué te gustaría hacer hoy?\n\n*1.* 🍔 Ver Menú y Ordenar\n*2.* 📞 Hablar con un humano`);
                sesion.paso = 'MENU_PRINCIPAL';
                break;

            case 'MENU_PRINCIPAL':
                if (texto === '1' || textoLower.includes('menu')) {
                    await cargarDatosFirebase(); 
                    let msg = "📋 *NUESTRAS CATEGORÍAS*\n\n";
                    categoriasCache.forEach((cat, idx) => msg += `*${idx + 1}.* ${cat}\n`);
                    msg += "\n👉 *Escribe el número de la categoría que deseas ver.*";
                    message.reply(msg);
                    sesion.paso = 'ELIGIENDO_CATEGORIA';
                } else if (texto === '2') {
                    message.reply("En un momento uno de nuestros asesores te atenderá personalmente. 🧑‍💻");
                    limpiarSesion(telefono);
                } else {
                    manejarError(sesion, message, "Responde con *1* (Menú) o *2* (Humano).");
                }
                break;

            case 'ELIGIENDO_CATEGORIA':
                const idxCat = parsearOpcion(texto, categoriasCache);
                if (idxCat < 0 || idxCat >= categoriasCache.length) return manejarError(sesion, message, "Ingresa un número de categoría válido.");
                
                sesion.errores = 0;
                sesion.categoriaSeleccionada = categoriasCache[idxCat];
                
                sesion.productosFiltrados = catalogoCache.filter(p => {
                    const cat = (p.categoria || '').toLowerCase();
                    const tags = (p.etiquetas || '').toLowerCase();
                    const busqueda = sesion.categoriaSeleccionada.toLowerCase();
                    return cat === busqueda || tags.includes(busqueda);
                });
                
                let msgProd = `📋 *${sesion.categoriaSeleccionada.toUpperCase()}*\n\n`;
                sesion.productosFiltrados.forEach((prod, i) => {
                    const precioMostrar = (prod.precioDescuento > 0) ? prod.precioDescuento : prod.precio;
                    let tachado = (prod.precioDescuento > 0) ? ` ~($${prod.precio})~` : '';
                    msgProd += `*${i + 1}.* ${prod.nombre} - $${precioMostrar}${tachado}\n`;
                });
                msgProd += "\n👉 *Escribe el número del producto que deseas agregar.*";
                
                message.reply(msgProd);
                sesion.paso = 'ELIGIENDO_PRODUCTO';
                break;

            case 'ELIGIENDO_PRODUCTO':
                const idxProd = parsearOpcion(texto, sesion.productosFiltrados.map(p => p.nombre));
                if (idxProd < 0 || idxProd >= sesion.productosFiltrados.length) return manejarError(sesion, message, "Escribe el número correcto del menú.");
                
                sesion.errores = 0;
                sesion.productoTemporal = sesion.productosFiltrados[idxProd];
                sesion.opcionesTemp = {}; 
                
                const esBebidaCheck = sesion.productoTemporal.categoria && sesion.productoTemporal.categoria.toLowerCase().includes('bebida');
                if (esBebidaCheck) {
                    sesion.paso = 'ELIGIENDO_CANTIDAD_BEBIDA';
                    message.reply(`Elegiste: *${sesion.productoTemporal.nombre}*.\n\n¿Qué *cantidad* deseas? (Escribe un número, ej: 1, 2, 3)`);
                } else {
                    avanzarPersonalizacion(sesion, message);
                }
                break;

            case 'ELIGIENDO_CANTIDAD_BEBIDA':
                const cantBebida = parseInt(texto);
                if (isNaN(cantBebida) || cantBebida <= 0) return manejarError(sesion, message, "Por favor escribe una cantidad válida.");
                op.cantidad = cantBebida;
                avanzarPersonalizacion(sesion, message);
                break;

            case 'ELIGIENDO_PROTEINA':
                if (texto === '1' || textoLower === 'alitas') op.proteina = 'Alitas';
                else if (texto === '2' || textoLower === 'boneless') op.proteina = 'Boneless';
                else if (texto === '3' || textoLower.includes('mitad')) op.proteina = 'Mitad y Mitad';
                else return manejarError(sesion, message, "Responde 1, 2 o 3.");
                avanzarPersonalizacion(sesion, message);
                break;

            case 'ELIGIENDO_VARIANTE':
                const vIndex = parsearOpcion(texto, sesion.productoTemporal.variantes.map(v => v.nombre));
                if (vIndex < 0 || vIndex >= sesion.productoTemporal.variantes.length) return manejarError(sesion, message, "Opción inválida.");
                op.variante = sesion.productoTemporal.variantes[vIndex];
                avanzarPersonalizacion(sesion, message);
                break;

            case 'ELIGIENDO_CANTIDAD_SALSAS':
                let cantSalsas = parseInt(texto);
                if (isNaN(cantSalsas) || cantSalsas < 1 || cantSalsas > sesion.productoTemporal.salsasMax) {
                    return manejarError(sesion, message, `Por favor ingresa un número entre 1 y ${sesion.productoTemporal.salsasMax}.`);
                }
                op.cantidadSalsas = cantSalsas;
                op.salsasElegidas = [];
                avanzarPersonalizacion(sesion, message);
                break;

            case 'ELIGIENDO_SALSA_MULTI':
                const sIndexMulti = parsearOpcion(texto, SALSAS);
                if (sIndexMulti < 0 || sIndexMulti >= SALSAS.length) return manejarError(sesion, message, "Opción de salsa inválida.");
                if (!op.salsasElegidas) op.salsasElegidas = [];
                op.salsasElegidas.push(SALSAS[sIndexMulti]);
                avanzarPersonalizacion(sesion, message);
                break;

            case 'ELIGIENDO_PAPA':
                const pIndex = parsearOpcion(texto, PAPAS);
                if (pIndex < 0 || pIndex >= PAPAS.length) return manejarError(sesion, message, "Opción de sabor inválida.");
                op.papa = PAPAS[pIndex];
                avanzarPersonalizacion(sesion, message);
                break;

            case 'ELIGIENDO_ADEREZO':
                const aIndex = parsearOpcion(texto, ADEREZOS);
                if (aIndex < 0 || aIndex >= ADEREZOS.length) return manejarError(sesion, message, "Opción de aderezo inválida.");
                op.aderezo = ADEREZOS[aIndex];
                avanzarPersonalizacion(sesion, message);
                break;

            case 'CONFIRMANDO_CARRITO':
                if (texto === '1') {
                    let msg = "📋 *NUESTRAS CATEGORÍAS*\n\n";
                    categoriasCache.forEach((cat, idx) => msg += `*${idx + 1}.* ${cat}\n`);
                    message.reply(msg);
                    sesion.paso = 'ELIGIENDO_CATEGORIA';
                } else if (texto === '2') {
                    message.reply("¿Cómo será tu pedido?\n\n*1.* 🛵 Envío a Domicilio *(+$10 MXN)*\n*2.* 🚶‍♂️ Pasar a Recoger");
                    sesion.paso = 'TIPO_ENTREGA';
                } else {
                    manejarError(sesion, message, "Responde con 1 o 2.");
                }
                break;

            case 'TIPO_ENTREGA':
                if (texto === '1') {
                    sesion.tipoEntrega = 'Domicilio';
                    message.reply("📍 Por favor, escribe tu *dirección completa* (Calle, Número, Colonia, Referencias) o envíanos tu *Ubicación GPS* 📎 usando el clip de WhatsApp.");
                    sesion.paso = 'ESPERANDO_DIRECCION';
                } else if (texto === '2') {
                    sesion.tipoEntrega = 'Recoger';
                    sesion.direccion = 'Pasa a recoger en sucursal';
                    message.reply("¿Cómo vas a pagar?\n\n*1.* 💵 Efectivo\n*2.* 💳 Terminal (Aplica comisión de 5%)\n*3.* 📲 Transferencia");
                    sesion.paso = 'ESPERANDO_PAGO';
                } else {
                    manejarError(sesion, message, "Responde con 1 o 2.");
                }
                break;

            case 'ESPERANDO_DIRECCION':
                if (message.type === 'location') {
                    sesion.direccion = `Ubicación GPS: https://maps.google.com/?q=${message.location.latitude},${message.location.longitude}`;
                } else {
                    sesion.direccion = texto;
                }
                message.reply("¿Cómo vas a pagar?\n\n*1.* 💵 Efectivo\n*2.* 💳 Terminal (Aplica comisión de 5%)\n*3.* 📲 Transferencia");
                sesion.paso = 'ESPERANDO_PAGO';
                break;

            case 'ESPERANDO_PAGO':
                if (texto === '1') sesion.metodoPago = 'Efectivo';
                else if (texto === '2') sesion.metodoPago = 'Terminal';
                else if (texto === '3') {
                    sesion.metodoPago = 'Transferencia';
                    message.reply("🏦 *Datos para Transferencia:*\nBanco: BBVA\nCuenta: 0123456789\nCLABE: 012345678901234567\nNombre: Alli's Restaurante\n\n_(Puedes enviar la foto de tu comprobante por este chat)_");
                }
                else return manejarError(sesion, message, "Responde con 1, 2 o 3.");

                message.reply("Generando tu orden... ⏳");

                let total = 0;
                let resumenItems = "";
                sesion.carrito.forEach(item => {
                    total += item.precioTotal;
                    resumenItems += `${item.cantidad}x ${item.nombre} ($${item.precioTotal.toFixed(2)})\n`;
                    if (item.proteina) resumenItems += `   🥩 Proteína: ${item.proteina}\n`;
                    if (item.variante) resumenItems += `   🔸 Tamaño: ${item.variante}\n`;
                    if (item.salsas) resumenItems += `   🌶️ Salsas: ${item.salsas}\n`;
                    if (item.saborPapas) resumenItems += `   🍟 Papas: ${item.saborPapas}\n`;
                    if (item.aderezos) resumenItems += `   🥗 Aderezo: ${item.aderezos}\n`;
                });

                if (sesion.tipoEntrega === 'Domicilio') {
                    total += 10;
                    resumenItems += `\n🛵 Costo de Envío: $10.00\n`;
                }

                // COMISIÓN DEL 5% SI ES TERMINAL
                if (sesion.metodoPago === 'Terminal') {
                    const comision = total * 0.05;
                    total += comision;
                    resumenItems += `💳 Comisión Terminal (5%): $${comision.toFixed(2)}\n`;
                }

                const numeroFolio = "WA" + Math.floor(1000 + Math.random() * 9000);
                const telLimpio = telefono.split('@')[0];

                const nuevoPedido = {
                    numeroPedido: numeroFolio, usuarioId: "whatsapp_bot", nombreCliente: sesion.nombre,
                    telefono: telLimpio, estado: "Pendiente", monto: total, metodoPago: sesion.metodoPago,
                    tipoEntrega: sesion.tipoEntrega, direccion: sesion.direccion, fecha: new Date().toISOString(),
                    items: sesion.carrito, origen: "WhatsApp Bot",
                    mensajes: [{ rol: 'chatapp', texto: 'El cliente generó este pedido automáticamente a través del Bot de WhatsApp.', fecha: new Date().toISOString() }]
                };

                await addDoc(collection(db, "pedidos"), nuevoPedido);

                const ticket = `✅ *¡PEDIDO CONFIRMADO!*\n\n*Folio:* #${numeroFolio}\n*Nombre:* ${sesion.nombre}\n*Entrega:* ${sesion.tipoEntrega}\n*Pago:* ${sesion.metodoPago}\n\n*Tu Orden:*\n${resumenItems}\n*TOTAL: $${total.toFixed(2)}*\n\nEn breve nuestro equipo comenzará a prepararlo. ¡Gracias por tu preferencia! 🍔🔥`;

                message.reply(ticket);
                limpiarSesion(telefono);
                break;
        }
    } catch (error) {
        console.error("Error:", error);
        message.reply("Ocurrió un problema. Por favor intenta más tarde.");
    }
});

client.initialize();