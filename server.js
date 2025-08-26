const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios'); // Utilize axios para requisições HTTP
const { Op } = require('sequelize');
const { Product, PurchaseHistory } = require('./models');


const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rota para a página de administração
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- CONFIGURAÇÃO DA NOVA API DE PAGAMENTO (ONDAPAY) ---
const ONDAPAY_API_URL = "https://api.ondapay.app";
const ONDAPAY_CLIENT_ID = "c62e7acd-8c6d-4056-93b7-19dd8f5fe930";
const ONDAPAY_CLIENT_SECRET = "x6HB3VsRbnFMfsasTH2eK1HMbsExkiLM";
const WEBHOOK_URL = "https://cinepremiumedit.domcloud.dev/ondapay-webhook";

let ondaPayToken = null;

// Função para obter/renovar o token de autenticação
async function getOndaPayToken() {
  // AQUI, em um projeto de produção, você adicionaria uma lógica para
  // verificar se o token expirou antes de pedir um novo.
  // Por simplicidade, estamos pegando um novo token a cada reinicialização do servidor.
  if (ondaPayToken) {
    return ondaPayToken;
  }

  try {
    const response = await axios.post(`${ONDAPAY_API_URL}/api/v1/login`, {}, {
      headers: {
        'client_id': ONDAPAY_CLIENT_ID,
        'client_secret': ONDAPAY_CLIENT_SECRET,
        'Content-Type': 'application/json'
      }
    });
    ondaPayToken = response.data.token;
    console.log("Token da OndaPay obtido com sucesso.");
    return ondaPayToken;
  } catch (error) {
    console.error("Erro ao obter token da OndaPay:", error.response ? error.response.data : error.message);
    // Invalida o token em caso de erro para forçar uma nova tentativa na próxima vez
    ondaPayToken = null; 
    throw new Error("Não foi possível autenticar com o serviço de pagamento.");
  }
}


// Endpoint para gerar QR Code de pagamento (adaptado para OndaPay)
app.post('/gerarqrcode', async (req, res) => {
  try {
    // 1. RECEBE O NOVO CAMPO 'email'
    const { value, nome, telefone, cpf, email, productTitle, productDescription } = req.body;
    if (!value || !nome || !telefone || !cpf || !email) {
      return res.status(400).json({ error: "Todos os campos, incluindo e-mail, são obrigatórios." });
    }
    
    // A lógica de prevenção de tentativas múltiplas permanece a mesma
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const attemptsLastHour = await PurchaseHistory.count({
      where: {
        telefone,
        dataTransacao: { [Op.gte]: oneHourAgo }
      }
    });
    
    const attemptsLastMonth = await PurchaseHistory.count({
      where: {
        telefone,
        dataTransacao: { [Op.gte]: oneMonthAgo }
      }
    });
    
    if (attemptsLastHour >= 3 || attemptsLastMonth >= 5) {
      return res.status(429).json({ 
        error: 'Você já tentei pagar muitas vezes, procure seu vendedor ou tente novamente depois de algumas horas'
      });
    }

    const token = await getOndaPayToken();
    
    // Cria um registro inicial no histórico para gerar um external_id
    const purchaseRecord = await PurchaseHistory.create({ nome, telefone, status: 'Gerado' });

    // >>>>> ALTERAÇÃO AQUI: Adicionando dueDate <<<<<
    const expirationDate = new Date();
    expirationDate.setMinutes(expirationDate.getMinutes() + 30); // Define a validade para 30 minutos a partir de agora

    const pad = (num) => String(num).padStart(2, '0');
    // Formata a data para 'AAAA-MM-DD HH:MM:SS'
    const dueDateFormatted = `${expirationDate.getFullYear()}-${pad(expirationDate.getMonth() + 1)}-${pad(expirationDate.getDate())} ${pad(expirationDate.getHours())}:${pad(expirationDate.getMinutes())}:${pad(expirationDate.getSeconds())}`;

    // >>>>> ALTERAÇÃO AQUI: Adicionando email e dueDate ao payload <<<<<
    const payload = {
      amount: parseFloat((value / 100).toFixed(2)), // API espera um float
      external_id: purchaseRecord.id.toString(),
      webhook: WEBHOOK_URL,
      description: `${productTitle} - ${productDescription || ''}`,
      dueDate: dueDateFormatted, // Campo obrigatório
      payer: {
        name: nome,
        document: cpf.replace(/\D/g, ''),
        email: email // Campo obrigatório
      }
    };
    
    const response = await axios.post(`${ONDAPAY_API_URL}/api/v1/deposit/pix`, payload, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      }
    });

    const data = response.data;
    
    // Atualiza nosso registro no banco com o ID da transação da OndaPay
    await purchaseRecord.update({ transactionId: data.id_transaction });
    
    const resultado = {
      id: data.id_transaction,
      qr_code: data.qrcode,
      qr_code_base64: data.qrcode_base64
    };

    console.log("QR Code gerado (OndaPay):", resultado.id);
    res.json(resultado);
  } catch (error) {
    let errorMessage = "Erro interno ao gerar QR code.";
    // Verifica se a resposta de erro veio da API da OndaPay
    if (error.response && error.response.data && error.response.data.msg) {
        // Pega a primeira mensagem de erro retornada pela API
        errorMessage = Object.values(error.response.data.msg)[0];
        console.error("Erro da API OndaPay:", error.response.data);
    } else {
        console.error("Erro ao gerar QR code:", error.message);
    }
    res.status(400).json({ error: errorMessage });
  }
});


// NOVO ENDPOINT: Webhook para receber confirmação de pagamento
app.post('/ondapay-webhook', async (req, res) => {
    // LOG ADICIONADO: Mostra o corpo completo da requisição do webhook
    console.log('--- [WEBHOOK LOG] --- Webhook Recebido. Corpo da requisição:');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('--- [WEBHOOK LOG] --- Fim do corpo da requisição.');

    try {
      const { status, transaction_id, external_id } = req.body;
      
      // Valida se os dados essenciais estão presentes
      if (!status || !transaction_id || !external_id) {
        console.warn(`[WEBHOOK LOG] Webhook recebido com dados incompletos.`, req.body);
        return res.status(400).send('Dados do webhook incompletos.');
      }
  
      if (status.toUpperCase() === 'PAID_OUT') {
        // LOG ADICIONADO: Confirma que a condição de pagamento foi atendida
        console.log(`[WEBHOOK LOG] Status 'PAID_OUT' detectado para external_id: ${external_id}`);
        
        const purchaseId = parseInt(external_id, 10);
        
        if (isNaN(purchaseId)) {
          console.error(`[WEBHOOK LOG] Erro: external_id '${external_id}' não é um número válido.`);
          return res.status(400).send('external_id inválido.');
        }

        // LOG ADICIONADO: Informa que a atualização do banco de dados será tentada
        console.log(`[WEBHOOK LOG] Tentando atualizar o registro com ID: ${purchaseId} para 'Sucesso'.`);
        const [updatedRows] = await PurchaseHistory.update(
          { status: 'Sucesso' },
          { where: { id: purchaseId } }
        );

        if (updatedRows > 0) {
            console.log(`[WEBHOOK LOG] SUCESSO! ${updatedRows} registro(s) atualizado(s) para a compra ID ${purchaseId}.`);
        } else {
            console.warn(`[WEBHOOK LOG] AVISO: Nenhum registro encontrado ou atualizado para o ID de compra ${purchaseId}. Verifique se o external_id está correto.`);
        }
      } else {
        // LOG ADICIONADO: Informa qual status foi recebido, caso não seja 'PAID_OUT'
        console.log(`[WEBHOOK LOG] Status recebido foi '${status}'. Nenhuma ação necessária.`);
      }
      
      res.status(200).send({ status: 'ok' });
  
    } catch (error) {
      console.error("[WEBHOOK LOG] Erro crítico no processamento do webhook:", error.message);
      res.status(500).send('Erro interno ao processar webhook.');
    }
  });


// ENDPOINT MODIFICADO: Agora verifica o status localmente
app.post('/check-local-status', async (req, res) => {
    try {
      const { id } = req.body; // Este é o transactionId da OndaPay
      if (!id) return res.status(400).json({ error: "ID da transação não fornecido." });
  
      const purchase = await PurchaseHistory.findOne({ where: { transactionId: id } });
  
      if (!purchase) {
        // LOG ADICIONADO: Informa quando uma verificação de status não encontra um registro correspondente
        console.log(`[STATUS CHECK] Nenhuma compra encontrada para o transactionId: ${id}. Retornando 'Gerado'.`);
        return res.json({ id: id, status: 'Gerado' });
      }
      
      // LOG ADICIONADO: Mostra o status que está sendo retornado para o frontend
      console.log(`[STATUS CHECK] Status para transactionId ${id} é '${purchase.status}'. Enviando para o cliente.`);
      res.json({ id: purchase.transactionId, status: purchase.status });
  
    } catch (error) {
      console.error("[STATUS CHECK] Erro ao verificar status local:", error.message);
      res.status(500).json({ error: "Erro ao verificar status localmente" });
    }
});


// --- ENDPOINTS DE ADMINISTRAÇÃO E PRODUTOS (sem alterações) ---

app.post('/api/products', async (req, res) => {
    try {
      const { title, price, image, description } = req.body;
      if (!title || !price || !image) {
        return res.status(400).json({ error: 'Título, preço e imagem são obrigatórios.' });
      }
      const product = await Product.create({ title, price, image, description });
      res.json(product);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao criar produto.' });
    }
});

app.get('/api/products', async (req, res) => {
    try {
      const products = await Product.findAll({ order: [['orderIndex', 'ASC']] });
      res.json(products);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao buscar produtos.' });
    }
});
  
app.put('/api/products/reorder', async (req, res) => {
    try {
      const { order } = req.body;
      if (!order || !Array.isArray(order)) {
        return res.status(400).json({ error: 'Array de ordem é obrigatório.' });
      }
      for (let i = 0; i < order.length; i++) {
        await Product.update({ orderIndex: i }, { where: { id: order[i] } });
      }
      res.json({ message: 'Ordem atualizada com sucesso.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao atualizar a ordem dos produtos.' });
    }
});

app.delete('/api/products/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const rowsDeleted = await Product.destroy({ where: { id } });
      if (rowsDeleted === 0) {
        return res.status(404).json({ error: 'Produto não encontrado.' });
      }
      res.json({ message: 'Produto excluído com sucesso.' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao excluir produto.' });
    }
});

app.get('/api/purchase-history', async (req, res) => {
    try {
      const { nome, telefone, mes, ano } = req.query;
      let where = {};
  
      if (nome) {
        where.nome = { [Op.like]: `%${nome}%` };
      }
      if (telefone) {
        where.telefone = telefone;
      }
      if (mes && ano) {
        const startDate = new Date(ano, mes - 1, 1);
        const endDate = new Date(ano, mes, 0, 23, 59, 59);
        where.dataTransacao = { [Op.between]: [startDate, endDate] };
      }
  
      const history = await PurchaseHistory.findAll({ where, order: [['dataTransacao', 'DESC']] });
      res.json(history);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao buscar histórico.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  await getOndaPayToken();
});