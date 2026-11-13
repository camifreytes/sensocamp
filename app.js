// ============ CONEXION CON SUPABASE (la base) ============
const SUPABASE_URL="https://dglkfkjtoiuwyrbamffh.supabase.co";
const SUPABASE_KEY="sb_publishable_WriDIJKqVoOUVDmNSbbl6Q_PwUJHasx";
const HDR={apikey:SUPABASE_KEY,Authorization:"Bearer "+SUPABASE_KEY};
async function sb(path,opt){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{...opt,headers:{...HDR,...((opt&&opt.headers)||{})}});
  if(!r.ok) throw new Error("HTTP "+r.status);
  return r.json();
}
const leerLotes=()=>sb("lotes?select=id,nombre,ubicacion,latitud,longitud&order=id.asc");
const leerCultivos=()=>sb("cultivos?select=nombre,ph_min,ph_max,hum_min,hum_max,temp_min_siembra,notas&order=id.asc");
// trae TODAS las lecturas (OK, DUDOSO, FALLA, NO_MUESTREADO); la recomendacion usa solo las OK
const leerLecturas=id=>sb(`lecturas?lote_id=eq.${id}&order=creado_en.asc&select=creado_en,nodo_ts,humedad_pct,ph,temp_c,luz_lux,est_hum,est_ph,est_temp,est_luz,estado_general,pasada,campania,observacion`);
const leerProyeccion=(id,fecha)=>sb("rpc/proyeccion_siembra",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({p_lote:id,p_fecha:fecha})});
// =========================================================

const EMOJI={"Soja":"🫘","Maíz":"🌽","Girasol":"🌻","Trigo":"🌾"};
const COLORS={humedad:"#3f82c4",ph:"#8a6a46",temp:"#c0402f",luz:"#c98a1a"};
const MIN_LECTURAS_OK=2;
const css=v=>getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const enRango=(v,[a,b])=>v>=a&&v<=b;
const fmtF=d=>new Date(d).toLocaleDateString("es-AR",{day:"2-digit",month:"short"});
const fmtFL=d=>new Date(d).toLocaleDateString("es-AR",{day:"2-digit",month:"short",year:"numeric"});
const tsOf=r=>new Date(r.nodo_ts||r.creado_en);
const num=(v,d)=>(v==null||isNaN(v))?"—":(+v).toFixed(d);

const S={vivo:false,error:null,cultivos:[],lotes:[],datos:{},actual:null,fsiembra:null,tokenProy:0};

// ---------- analisis de las lecturas de un lote ----------
const SENS=[["hum","humedad_pct",1],["ph","ph",1],["temp","temp_c",1],["luz","luz_lux",1000]];
function analizar(rowsIn){
  const rows=rowsIn.slice().sort((a,b)=>tsOf(a)-tsOf(b));
  const cnt={OK:0,DUDOSO:0,FALLA:0,NO_MUESTREADO:0};
  rows.forEach(r=>{if(cnt[r.estado_general]!==undefined)cnt[r.estado_general]++;});
  const serie={},prom={},n={};let okN=0,intN=0;
  SENS.forEach(([k,f,div])=>{
    serie[k]=rows.filter(r=>r["est_"+k]==="OK"&&r[f]!=null).map(r=>({t:tsOf(r),v:+r[f]/div}));
    n[k]=serie[k].length;
    prom[k]=n[k]?serie[k].reduce((a,x)=>a+x.v,0)/n[k]:null;
    rows.forEach(r=>{if(r["est_"+k]){intN++;if(r["est_"+k]==="OK")okN++;}});
  });
  const conDatos=rows.filter(r=>r.estado_general!=="NO_MUESTREADO");
  const ultima=conDatos.length?conDatos[conDatos.length-1]:null;
  const oks=rows.filter(r=>r.estado_general==="OK");
  const ultimaOK=oks.length?oks[oks.length-1]:null;
  let seguidos=0;for(let i=rows.length-1;i>=0&&rows[i].estado_general==="NO_MUESTREADO";i--)seguidos++;
  const ejemplo=rows.filter(r=>/ejemplo/i.test(r.observacion||"")).length;
  // campanias (para comparar con la anterior)
  const camp={};
  rows.forEach(r=>{if(r.campania){(camp[r.campania]=camp[r.campania]||{nombre:r.campania,primera:tsOf(r),rows:[]}).rows.push(r);}});
  const campanias=Object.values(camp).sort((a,b)=>a.primera-b.primera).map(c=>{
    const a=analizar2(c.rows);return {nombre:c.nombre,n:c.rows.length,...a};});
  return {rows,cnt,serie,prom,n,pctOk:intN?100*okN/intN:null,ultima,ultimaOK,seguidos,ejemplo,campanias,
    suficiente:n.hum>=MIN_LECTURAS_OK&&n.ph>=MIN_LECTURAS_OK&&n.temp>=MIN_LECTURAS_OK};
}
function analizar2(rows){ // promedios OK por sensor de un subconjunto (campania)
  const o={};[["hum","humedad_pct"],["ph","ph"],["temp","temp_c"]].forEach(([k,f])=>{
    const v=rows.filter(r=>r["est_"+k]==="OK"&&r[f]!=null).map(r=>+r[f]);o[k]=v.length?v.reduce((a,b)=>a+b,0)/v.length:null;});
  return o;
}

// ---------- recomendacion: promedio de lecturas OK + margen de ajuste ----------
function evaluar(cultivos,p,h,t){
  const m=(v,[a,b])=>Math.max(0,Math.min(1,Math.min(v-a,b-v)/((b-a)/2)));
  return cultivos.map(c=>{
    const okPh=enRango(p,c.ph),okHum=enRango(h,c.hum),okT=t>=c.tmin;
    const partes=[m(p,c.ph),m(h,c.hum),Math.max(0,Math.min(1,(t-c.tmin)/5))];
    return {...c,okPh,okHum,okT,apto:okPh&&okHum&&okT,margen:Math.min(...partes),media:partes.reduce((a,b)=>a+b,0)/3};
  });
}
const ordenar=ev=>ev.filter(c=>c.apto).sort((a,b)=>(b.margen-a.margen)||(b.media-a.media));

// ---------- inicio ----------
(async function init(){
  const b=document.getElementById("badge"),bt=document.getElementById("badgeTxt");
    try{
      const [cult,lotes]=await Promise.all([leerCultivos(),leerLotes()]);
      S.cultivos=cult.map(c=>({nombre:c.nombre,ph:[+c.ph_min,+c.ph_max],hum:[+c.hum_min,+c.hum_max],tmin:+c.temp_min_siembra,nota:c.notas||""}));
      S.lotes=lotes;
      const todas=await Promise.all(lotes.map(l=>leerLecturas(l.id)));
      lotes.forEach((l,i)=>{S.datos[l.id]=todas[i];});
      S.vivo=true; b.className="badge vivo"; bt.textContent="EN VIVO · SUPABASE";
    }catch(e){
      S.error=e.message; b.className="badge off"; bt.textContent="SIN CONEXIÓN CON LA BASE";
    }
  
  S.actual=S.lotes.length?S.lotes[0].id:null;
  const d=new Date();d.setDate(d.getDate()+21);S.fsiembra=d.toISOString().slice(0,10);
  const le=document.getElementById("lotes");
  S.lotes.forEach(l=>{const btn=document.createElement("button");btn.textContent=l.nombre;btn.dataset.id=l.id;btn.onclick=()=>{S.actual=l.id;render();};le.appendChild(btn);});
  render();
})();

// ---------- pantalla ----------
function render(){
  const app=document.getElementById("app");
  if(S.error||!S.lotes.length){
    app.innerHTML=`<div class="hero nd"><div class="hk"><span>Recomendación de cultivo</span><span>Sin datos</span></div>
      <div class="pick" style="margin-top:8px"><span class="e">⚠️</span><div><div class="n">Sin datos</div><div class="s">${S.error?"No se pudo leer la base ("+esc(S.error)+"). No se muestra ninguna recomendación.":"La base no tiene lotes cargados."}</div></div></div></div>`;
    return;
  }
  const lote=S.lotes.find(l=>l.id===S.actual)||S.lotes[0];
  const A=analizar(S.datos[lote.id]||[]);
  const U=A.ultima;
  const cult=S.cultivos;
  const rango=(k)=>{const v=cult.map(c=>c[k]);return v.length?[Math.min(...v.map(x=>x[0])),Math.max(...v.map(x=>x[1]))]:null;};
  const ev=A.suficiente&&cult.length?evaluar(cult,A.prom.ph,A.prom.hum,A.prom.temp):null;
  const aptos=ev?ordenar(ev):[];
  const top=aptos[0];
  const lat=lote.latitud!=null&&lote.longitud!=null?` · 📍 ${(+lote.latitud).toFixed(4)}, ${(+lote.longitud).toFixed(4)} (aprox.)`:"";
  const estG=U?U.estado_general:"SIN";

  // alertas
  const al=[];
  if(U&&U.estado_general==="FALLA"){
    const f=SENS.filter(([k])=>U["est_"+k]==="FALLA").map(([k])=>({hum:"humedad",ph:"pH",temp:"temperatura",luz:"luz"}[k]));
    al.push(["alta",`Falla en la última lectura (${f.join(", ")||"sensor"}). Revisar el nodo antes de confiar en los datos.`]);
  }
  if(A.seguidos>=2) al.push(["media",`${A.seguidos} puntos seguidos sin muestrear (obstáculo). Revisar el recorrido.`]);
  const rp=rango("ph"),rh=rango("hum");
  if(A.suficiente&&rp&&rh&&(A.prom.ph<rp[0]||A.prom.ph>rp[1]||A.prom.hum<rh[0]||A.prom.hum>rh[1]))
    al.push(["media",`pH (${A.prom.ph.toFixed(1)}) o humedad (${A.prom.hum.toFixed(0)} %) promedio fuera del rango de todos los cultivos.`]);
  if(A.pctOk!=null&&A.pctOk<50) al.push(["media",`Solo ${A.pctOk.toFixed(0)} % de las lecturas de sensores salieron OK: confianza baja.`]);
  const total=A.rows.length;
  al.push(["info",`Lecturas: <b>${total}</b> · OK ${A.cnt.OK} · DUDOSO ${A.cnt.DUDOSO} · FALLA ${A.cnt.FALLA} · NO_MUESTREADO ${A.cnt.NO_MUESTREADO}`+
    (A.pctOk!=null?` · <b>${A.pctOk.toFixed(0)} % de lecturas de sensores OK</b>`:"")]);

  // KPIs (ultima fila con datos)
  const kpi=(l,key,field,u,dec,div,k)=>{
    const raw=U?U[field]:null,est=U&&U["est_"+key]?U["est_"+key]:"SIN",ok=raw!=null;
    const s=A.serie[key].map(x=>x.v);
    return `<div class="kpi ${ok?"":"nd"}"><span class="l">${l}</span><span class="n">${ok?(+raw/div).toFixed(dec):"—"}<i> ${ok?u:""}</i></span><span class="pill ${est}">${est==="SIN"?"SIN DATO":est}</span>${spark(s,COLORS[k])}</div>`;
  };
  const kpis=`<div class="g4">
    ${kpi("Humedad","hum","humedad_pct","%",0,1,"humedad")}
    ${kpi("pH","ph","ph","",1,1,"ph")}
    ${kpi("Temperatura","temp","temp_c","°C",0,1,"temp")}
    ${kpi("Luz (informativa)","luz","luz_lux","klux",0,1000,"luz")}
  </div>`;

  // hero
  let hero;
  if(ev&&top){
    const ref=top;
    const why=[["pH promedio",A.prom.ph.toFixed(1),ref.okPh],["Humedad promedio",A.prom.hum.toFixed(0)+" %",ref.okHum],["Temperatura promedio",A.prom.temp.toFixed(0)+" °C",ref.okT]];
    hero=`<div class="hero">
      <div class="hk"><span>Recomendación de cultivo</span><span>${aptos.length} cultivo(s) apto(s)</span></div>
      <div class="hb"><div>
        <div class="pick"><span class="e">${EMOJI[top.nombre]||"🌱"}</span><div><div class="n">${esc(top.nombre)}</div><div class="s">${esc(top.nota)} · margen de ajuste ${(top.margen*100).toFixed(0)} %</div></div></div>
        <div class="alts">${aptos.length>1?`También aptos (de mejor a peor ajuste): <b>${aptos.slice(1).map(c=>esc(c.nombre)).join(", ")}</b>`:"Es el único cultivo apto con el suelo actual."}</div>
      </div>
      <div class="why">${why.map(([l,v,ok])=>`<div class="r"><span class="dot ${ok?'ok':'no'}"></span><span class="l">${l}</span><span class="v">${v}</span></div>`).join("")}</div></div>
      <div class="ethics">⚠️ Recomendación orientativa basada solo en las lecturas de los sensores (promedio de ${A.n.hum} lecturas de humedad, ${A.n.ph} de pH y ${A.n.temp} de temperatura OK). La decisión final es del productor. Verificá que el cultivo elegido no afecte a campos vecinos ni al ambiente.</div>
    </div>`;
  }else if(ev){
    hero=`<div class="hero">
      <div class="hk"><span>Recomendación de cultivo</span><span>0 cultivo(s) apto(s)</span></div>
      <div class="pick" style="margin-top:8px"><span class="e">⚠️</span><div><div class="n">Sin recomendación</div><div class="s">Ningún cultivo cumple las 3 condiciones con los promedios actuales (pH ${A.prom.ph.toFixed(1)}, humedad ${A.prom.hum.toFixed(0)} %, ${A.prom.temp.toFixed(0)} °C)</div></div></div>
      <div class="ethics">⚠️ Recomendación orientativa basada solo en las lecturas de los sensores. La decisión final es del productor. Verificá que el cultivo elegido no afecte a campos vecinos ni al ambiente.</div></div>`;
  }else{
    hero=`<div class="hero nd">
      <div class="hk"><span>Recomendación de cultivo</span><span>Sin datos suficientes</span></div>
      <div class="pick" style="margin-top:8px"><span class="e">⚠️</span><div><div class="n">Datos insuficientes</div>
        <div class="s">Recomendación no confiable: hacen falta al menos ${MIN_LECTURAS_OK} lecturas OK de humedad, pH y temperatura. Hay ${A.n.hum} de humedad, ${A.n.ph} de pH y ${A.n.temp} de temperatura${A.ultimaOK?` · última medición válida: ${fmtFL(tsOf(A.ultimaOK))}`:" · todavía sin mediciones válidas"}.</div></div></div>
      <div class="ethics">Las lecturas DUDOSO y FALLA se guardan en la base para auditarlas, pero no se usan para recomendar.</div></div>`;
  }

  // tabla de cultivos
  const tabla=ev?`<h2>¿Qué conviene sembrar?</h2>
  <div class="card"><table>
    <thead><tr><th>Cultivo</th><th>pH</th><th>Humedad</th><th>Temp.</th><th>Margen</th><th>Resultado</th></tr></thead>
    <tbody>${ev.slice().sort((a,b)=>(b.apto-a.apto)||(b.margen-a.margen)).map(c=>`<tr>
      <td class="crop">${EMOJI[c.nombre]||"🌱"} ${esc(c.nombre)}<small>${esc(c.nota)}</small></td>
      <td class="mk ${c.okPh?'ok':'no'}">${c.okPh?'✓':'✗'}<small><br>${c.ph[0]}–${c.ph[1]}</small></td>
      <td class="mk ${c.okHum?'ok':'no'}">${c.okHum?'✓':'✗'}<small><br>${c.hum[0]}–${c.hum[1]}%</small></td>
      <td class="mk ${c.okT?'ok':'no'}">${c.okT?'✓':'✗'}<small><br>≥${c.tmin}°C</small></td>
      <td>${c.apto?(c.margen*100).toFixed(0)+" %":"—"}</td>
      <td><span class="vd ${c.apto?'si':'no'}">${c.apto?'APTO':'NO'}</span></td></tr>`).join("")}</tbody>
  </table></div>`:"";

  // graficos
  const ch=(tit,sub,key,color)=>chart(tit,sub,A.serie[key].map(x=>x.v),color,A.serie[key].map(x=>fmtF(x.t)));
  const graficos=`<h2>Evolución del suelo</h2><div class="charts">
    ${ch("Humedad","%","hum",COLORS.humedad)}${ch("pH","acidez","ph",COLORS.ph)}
    ${ch("Temperatura","°C","temp",COLORS.temp)}${ch("Luz","klux","luz",COLORS.luz)}</div>`;

  // proyeccion hacia la siembra
  const proy=`<h2>Proyección hacia la siembra</h2>
  <div class="card pad proj">
    <label>Fecha de siembra prevista <input type="date" id="fsiembra" value="${S.fsiembra}"></label>
    <div class="out" id="projOut">${S.demo?"La proyección se calcula en la base y no está disponible en el modo de ejemplo.":"Calculando…"}</div>
  </div>`;

  // campaña anterior
  let camp;
  if(A.campanias.length>=2){
    const c2=A.campanias[A.campanias.length-1],c1=A.campanias[A.campanias.length-2];
    const dl=(a,b,d,u)=>a==null||b==null?"—":`${num(a,d)}${u} (${(a-b>=0?"+":"")+(a-b).toFixed(d)}${u})`;
    camp=`<h2>Comparación con la campaña anterior</h2><div class="card"><table>
      <thead><tr><th>Campaña</th><th>Lecturas</th><th>Humedad prom.</th><th>pH prom.</th><th>Temp. prom.</th></tr></thead><tbody>
      <tr><td>${esc(c1.nombre)}</td><td>${c1.n}</td><td>${num(c1.hum,1)} %</td><td>${num(c1.ph,2)}</td><td>${num(c1.temp,1)} °C</td></tr>
      <tr><td><b>${esc(c2.nombre)}</b> (actual)</td><td>${c2.n}</td><td>${dl(c2.hum,c1.hum,1," %")}</td><td>${dl(c2.ph,c1.ph,2,"")}</td><td>${dl(c2.temp,c1.temp,1," °C")}</td></tr></tbody></table></div>`;
  }else{
    camp=`<h2>Comparación con la campaña anterior</h2><div class="card pad"><small style="color:var(--fg-muted)">Todavía no hay dos campañas con lecturas (el nodo enviará <code>campania</code> y <code>pasada</code> en cada lectura). Hoy hay ${A.campanias.length} campaña(s) registrada(s).</small></div>`;
  }

  // comparacion entre lotes
  const filas=S.lotes.map(l=>{
    const X=analizar(S.datos[l.id]||[]);
    const e=X.suficiente&&S.cultivos.length?ordenar(evaluar(S.cultivos,X.prom.ph,X.prom.hum,X.prom.temp))[0]:null;
    return `<tr><td>${esc(l.nombre)}${l.id===lote.id?" ◀":""}</td><td>${X.rows.length}</td><td>${X.pctOk==null?"—":X.pctOk.toFixed(0)+" %"}</td>
      <td>${X.ultimaOK?fmtFL(tsOf(X.ultimaOK)):"—"}</td><td>${X.suficiente?(e?(EMOJI[e.nombre]||"")+" "+esc(e.nombre):"Sin cultivo apto"):"<span style='color:var(--fg-muted)'>Datos insuficientes</span>"}</td></tr>`;
  }).join("");
  const comp=`<h2>Comparación entre lotes</h2><div class="card"><table>
    <thead><tr><th>Lote</th><th>Lecturas</th><th>% OK</th><th>Última medición válida</th><th>Recomendación</th></tr></thead><tbody>${filas}</tbody></table></div>`;

  app.innerHTML=`
  <div class="meta">
    <span><b>${esc(lote.nombre)}</b> · ${esc(lote.ubicacion||"")}${lat}</span>
    <span>Última medición: <b>${U?fmtFL(tsOf(U)):"—"}</b> · última válida (OK): <b>${A.ultimaOK?fmtFL(tsOf(A.ultimaOK)):"—"}</b></span>
    <span>Estado general: <span class="pill ${estG}">${estG==="SIN"?"SIN DATO":estG}</span></span>
  </div>
  <div class="alerts">${al.map(([t,m])=>`<div class="alert ${t}">${m}</div>`).join("")}</div>
  ${hero}${kpis}${tabla}${graficos}${proy}${camp}${comp}`;
  [...document.getElementById("lotes").children].forEach(b=>b.setAttribute("aria-pressed",+b.dataset.id===lote.id));
  const inp=document.getElementById("fsiembra");
  if(inp) inp.onchange=()=>{S.fsiembra=inp.value;cargarProyeccion(lote.id,A);};
  if(!S.demo) cargarProyeccion(lote.id,A);
}

// ---------- proyeccion (la calcula la base: funcion proyeccion_siembra) ----------
async function cargarProyeccion(loteId,A){
  const out=document.getElementById("projOut");if(!out||S.demo)return;
  const tk=++S.tokenProy;out.textContent="Calculando…";
  try{
    const res=await leerProyeccion(loteId,S.fsiembra);
    if(tk!==S.tokenProy)return;
    const p=Array.isArray(res)?res[0]:res;
    if(!p||p.humedad_proyectada==null){
      out.innerHTML=`<span class="pill FALLA">insuficiente</span><span>Hacen falta al menos 2 lecturas de humedad OK para proyectar (hay ${p?p.n_lecturas:0}). No se muestra proyección.</span>`;return;
    }
    const cls={alta:"OK",media:"DUDOSO",baja:"FALLA",insuficiente:"FALLA"}[p.confianza]||"DUDOSO";
    let extra="";
    if(A.n.ph>=MIN_LECTURAS_OK&&A.n.temp>=MIN_LECTURAS_OK&&S.cultivos.length){
      const ap=ordenar(evaluar(S.cultivos,A.prom.ph,+p.humedad_proyectada,A.prom.temp));
      extra=`<span>Con esa humedad, cultivos aptos: <b>${ap.length?ap.map(c=>esc(c.nombre)).join(", "):"ninguno"}</b>${p.confianza==="alta"?"":" <small>(estimación con confianza "+esc(p.confianza)+": no usar para decidir solo con esto)</small>"}</span>`;
    }
    out.innerHTML=`<span>Humedad proyectada al ${fmtFL(p.fecha_siembra+"T12:00:00")}: <span class="big">${(+p.humedad_proyectada).toFixed(1)} %</span> <small>(tendencia ${(+p.pendiente_pct_por_dia>=0?"+":"")+(+p.pendiente_pct_por_dia).toFixed(3)} puntos/día)</small></span>
      <span>Confianza: <span class="pill ${cls}">${esc(p.confianza)} · ${p.confianza_pct} %</span></span>
      <small>Basada en ${p.n_lecturas} lecturas de humedad OK. La última lectura (${fmtFL(p.ultima_lectura)}) queda a ${(+p.dias_ultima_a_siembra).toFixed(0)} días de la siembra: la confianza baja cuanto más lejos esté, porque el sistema no sabe cuánto va a llover en el medio. Se corrige sola cuando entran lecturas más cercanas a la siembra.</small>${extra}`;
  }catch(e){
    if(tk!==S.tokenProy)return;
    out.innerHTML=`<span class="pill FALLA">sin cálculo</span><span>No se pudo calcular la proyección (${esc(e.message)}).</span>`;
  }
}

function spark(s,color){if(s.length<2)s=[s[0]||0,s[0]||0];const w=150,h=34,p=3,mn=Math.min(...s),mx=Math.max(...s),rg=(mx-mn)||1;const pts=s.map((v,i)=>[p+i*(w-2*p)/(s.length-1),h-p-(v-mn)/rg*(h-2*p)]);const d=pts.map((q,i)=>(i?'L':'M')+q[0].toFixed(1)+' '+q[1].toFixed(1)).join(' ');const e=pts[pts.length-1];return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${e[0].toFixed(1)}" cy="${e[1].toFixed(1)}" r="2.6" fill="${color}"/></svg>`;}
function chart(tit,sub,s,color,fechas){const w=300,h=120,m={t:10,r:10,b:20,l:28};if(s.length<2)return `<div class="chart"><div class="t">${tit}</div><div class="s">${sub} — sin lecturas OK suficientes</div></div>`;const mn=Math.min(...s),mx=Math.max(...s),pd=(mx-mn)*0.18||1,lo=mn-pd,hi=mx+pd,rg=hi-lo;const X=i=>m.l+i*(w-m.l-m.r)/(s.length-1),Y=v=>h-m.b-(v-lo)/rg*(h-m.t-m.b);const line=s.map((v,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(v).toFixed(1)).join(' ');const area=`M${X(0).toFixed(1)} ${h-m.b} `+s.map((v,i)=>'L'+X(i).toFixed(1)+' '+Y(v).toFixed(1)).join(' ')+` L${X(s.length-1).toFixed(1)} ${h-m.b} Z`;const fg=css('--fg-muted'),ln=css('--line');let grid="";for(let i=0;i<=3;i++){const val=lo+rg*i/3,y=Y(val);grid+=`<line x1="${m.l}" x2="${w-m.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${ln}" stroke-width="0.5"/><text x="${m.l-5}" y="${(y+3).toFixed(1)}" text-anchor="end" font-size="8" fill="${fg}">${val.toFixed(rg<5?1:0)}</text>`;}const paso=Math.ceil(fechas.length/6);const xl=fechas.map((f,i)=>i%paso===0?`<text x="${X(i).toFixed(1)}" y="${h-6}" text-anchor="middle" font-size="8" fill="${fg}">${f}</text>`:"").join("");const dots=s.map((v,i)=>`<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2.3" fill="${color}"/>`).join("");return `<div class="chart"><div class="t">${tit}</div><div class="s">${sub} — solo lecturas OK</div><svg viewBox="0 0 ${w} ${h}">${grid}<path d="${area}" fill="${color}" opacity="0.10"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}${xl}</svg></div>`;}
