// ==== 0) Supabase + offline queue
const SUPABASE_URL = 'https://hgvimvswbzvhtuaszwqv.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhndmltdnN3Ynp2aHR1YXN6d3F2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA2Njg5MDcsImV4cCI6MjA3NjI0NDkwN30.vHtdIuMKCU5Su3ZoMbVLlKKSl3Xd0zxr0lmrG1kPiXc';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

localforage.config({ name: 'agenti-pwa', storeName: 'queue' });

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ==== 1) Tabs
$$('.tab-btn').forEach(b=>{
  b.addEventListener('click', ()=>{
    $$('.tab-btn').forEach(x=>x.classList.remove('border-neon','text-neon'));
    b.classList.add('border-neon','text-neon');
    const tab = b.dataset.tab;
    $$('.tab').forEach(x=>x.classList.add('hidden'));
    $('#'+tab).classList.remove('hidden');
    $('#'+tab).classList.add('active');
  });
});

// ==== 2) Bootstrap data
let PRODUCTS=[], COMPETITORS=[], PRICES=[];
async function loadBootstrap(){
  const { data: products } = await supabase.from('products').select('*').order('name');
  PRODUCTS = products || [];

  const { data: competitors } = await supabase.from('competitors').select('*').order('name');
  COMPETITORS = competitors || [];

  // dropdowns
  const prodSel = $('#produs-select'), simSel = $('#sim-product');
  prodSel.innerHTML=''; simSel.innerHTML='';
  PRODUCTS.forEach(p=>{
    const o1 = document.createElement('option'); o1.value=p.id; o1.textContent=p.name; prodSel.appendChild(o1);
    const o2 = document.createElement('option'); o2.value=p.id; o2.textContent=p.name; simSel.appendChild(o2);
  });
  const compSel = $('#competitor-select');
  compSel.innerHTML='';
  COMPETITORS.forEach(c=>{
    const o = document.createElement('option'); o.value=c.id; o.textContent=c.name; compSel.appendChild(o);
  });

  await renderCompetitorCards();
  await loadCompareData();
}
loadBootstrap();

// ==== 3) Cards progres competitori
async function countPerCompetitor(){
  // obținem toate înregistrările (ușor de înțeles; poți optimiza cu view sau RPC dacă vrei)
  const { data } = await supabase.from('prices').select('competitor_id');
  const m = new Map();
  (data||[]).forEach(r=>{
    m.set(r.competitor_id, (m.get(r.competitor_id)||0)+1);
  });
  return m;
}

async function renderCompetitorCards(){
  const container = $('#competitor-cards');
  container.innerHTML='';
  const counts = await countPerCompetitor();
  const total = PRODUCTS.length || 0;

  COMPETITORS.forEach(c=>{
    const completed = counts.get(c.id)||0;
    const pct = total ? Math.round(completed/total*100) : 0;

    const card = document.createElement('button');
    card.className = 'comp-card w-full text-left';
    card.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="font-semibold">${c.name}</div>
        <div class="text-xs opacity-80">${completed}/${total}</div>
      </div>
      <div class="mt-2 progress-outer"><div class="progress-inner" style="width:${pct}%"></div></div>
    `;
    // tap pe card -> filtrează tabul 2 pe competitor selectat
    card.addEventListener('click', ()=>{
      $$('.tab-btn')[1].click(); // switch la tab2
      $('#search-input').value=''; // doar comută; comparativul arată toți competitorii oricum
    });
    container.appendChild(card);
  });
}
$('#refresh-cards').addEventListener('click', renderCompetitorCards);

// ==== 4) Claim insert (cu fallback offline)
$('#add-price-btn').addEventListener('click', async ()=>{
  const product_id = $('#produs-select').value;
  const competitor_id = $('#competitor-select').value;
  const price = parseFloat($('#price-input').value);
  const agent = $('#agent-input').value || null;
  if(!product_id || !competitor_id || !(price>=0)) return toast('Completează câmpurile.');

  const payload = { product_id, competitor_id, price, agent };

  try{
    const { error } = await supabase.from('prices').insert(payload).select().single();
    if(error){
      if((error.code||'')==='23505') return toast('Există deja un preț pt. acest produs la acest competitor.');
      await queue(payload);
      toast('Eroare online. Am pus în coadă (offline) și sincronizăm automat.');
    } else {
      toast('Preț adăugat!');
      $('#price-input').value='';
      await renderCompetitorCards();
      await loadCompareData();
      haptic();
    }
  }catch{
    await queue(payload);
    toast('Ești offline. Am pus în coadă și sincronizăm când revine netul.');
  }
});

function toast(msg){
  const el = $('#collect-msg');
  el.textContent = msg;
  setTimeout(()=>{ el.textContent=''; }, 3500);
}
function haptic(){ if(navigator.vibrate) navigator.vibrate(8); }
async function queue(item){
  const q = (await localforage.getItem('q'))||[];
  q.push({t:'ins', item, ts:Date.now()});
  await localforage.setItem('q', q);
}
async function processQueue(){
  const q = (await localforage.getItem('q'))||[];
  if(!q.length) return;
  const rest=[];
  for(const job of q){
    try{
      if(job.t==='ins'){
        const { error } = await supabase.from('prices').insert(job.item);
        if(error && (error.code||'')!=='23505') rest.push(job);
      }
    }catch{ rest.push(job); }
  }
  await localforage.setItem('q', rest);
  if(q.length!==rest.length){ await renderCompetitorCards(); await loadCompareData(); }
}
window.addEventListener('online', processQueue);
setInterval(processQueue, 6000);

// ==== 5) Comparativ (căutare + dif + culori)
async function loadCompareData(){
  const { data } = await supabase
    .from('prices')
    .select(`
      id, price, product_id, competitor_id,
      competitors(name),
      products!inner(id,name,our_price)
    `);
  PRICES = data||[];
  renderCompare();
}
function renderCompare(){
  const term = ($('#search-input').value||'').toLowerCase();
  const wrap = $('#compare-rows');
  wrap.innerHTML='';
  const rows = PRICES.filter(r => (r.products?.name||'').toLowerCase().includes(term));

  rows.forEach(r=>{
    const ours = Number(r.products?.our_price||0);
    const theirs = Number(r.price||0);
    const dLei = +(ours-theirs).toFixed(2);
    const dPct = theirs>0 ? +(((ours-theirs)/theirs)*100).toFixed(2) : 0;
    const bad = dLei>0;

    const row = document.createElement('div');
    row.className = 'grid grid-cols-6 px-3 py-2 items-center';
    row.innerHTML = `
      <div class="truncate pr-2">${r.products?.name||'-'}</div>
      <div>${ours.toFixed(2)}</div>
      <div class="truncate">${r.competitors?.name||'-'}</div>
      <div>${theirs.toFixed(2)}</div>
      <div class="${bad?'k-bad':'k-good'}">${dLei.toFixed(2)}</div>
      <div class="${bad?'k-bad':'k-good'}">${dPct.toFixed(2)}%</div>
    `;
    wrap.appendChild(row);
  });
}
$('#search-input').addEventListener('input', renderCompare);
$('#reload-compare').addEventListener('click', loadCompareData);

// ==== 6) Simulator
let CART=[];
function bestFor(product_id){
  const rows = PRICES.filter(x=>x.product_id===product_id);
  if(!rows.length) return {name:'-', price:0};
  let best = rows[0];
  rows.forEach(x=>{ if(Number(x.price)<Number(best.price)) best=x; });
  return {name: best.competitors?.name||'-', price: Number(best.price||0)};
}
function recalcCart(){
  const wrap = $('#sim-rows'); wrap.innerHTML='';
  let totalOur=0, totalBest=0;

  CART.forEach((it, i)=>{
    const p = PRODUCTS.find(x=>x.id===it.product_id);
    const ours = Number(p?.our_price||0);
    const best = bestFor(it.product_id);
    const dLei = +(ours-best.price).toFixed(2);
    const dPct = best.price>0 ? +(((ours-best.price)/best.price)*100).toFixed(2) : 0;
    const bad = dLei>0;

    totalOur += ours*it.qty;
    totalBest += best.price*it.qty;

    const row = document.createElement('div');
    row.className = 'grid grid-cols-8 px-3 py-2 items-center';
    row.innerHTML = `
      <div class="truncate">${p?.name||'-'}</div>
      <div>${ours.toFixed(2)}</div>
      <div class="truncate">${best.name}</div>
      <div>${best.price.toFixed(2)}</div>
      <div class="${bad?'k-bad':'k-good'}">${dLei.toFixed(2)}</div>
      <div class="${bad?'k-bad':'k-good'}">${dPct.toFixed(2)}%</div>
      <div>${it.qty}</div>
      <div><button class="btn ghost text-xs" data-rm="${i}">Șterge</button></div>
    `;
    wrap.appendChild(row);
  });

  $('#sim-total').textContent = `${totalOur.toFixed(2)} lei`;
  let disc = 0;
  if(totalOur>0 && totalBest>0 && totalOur>totalBest) disc = (1 - (totalBest/totalOur))*100;
  $('#sim-discount').textContent = `${disc.toFixed(2)}%`;

  $$('#sim-rows [data-rm]').forEach(b=>{
    b.addEventListener('click', ()=>{ CART.splice(+b.dataset.rm,1); recalcCart(); haptic(); });
  });
}
$('#sim-add').addEventListener('click', ()=>{
  const product_id = $('#sim-product').value;
  const qty = Math.max(1, parseInt($('#sim-qty').value||'1',10));
  CART.push({product_id, qty});
  recalcCart(); haptic();
});
