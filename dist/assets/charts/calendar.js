import{openActivityDrawer as Z}from"./activities.js";const G=["January","February","March","April","May","June","July","August","September","October","November","December"],ae=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],oe=["All","Running","Cycling","Strength","Hiking","Walking","Other"],ie=[{id:"body_battery",label:"Body Battery",icon:"\u26A1"},{id:"sleep",label:"Sleep",icon:"\u{1F319}"},{id:"steps",label:"Steps",icon:"\u{1F463}"},{id:"rhr_stress",label:"RHR & Stress",icon:"\u2764\uFE0F"}],Q="garmin_dash_calendar_collapsed",j="garmin_dash_customization";function le(){try{if(typeof localStorage>"u")return!1;const e=localStorage.getItem(Q);if(e==="true"||e==="1")return!0;if(e==="false"||e==="0")return!1;const t=localStorage.getItem(j);if(t){const r=JSON.parse(t);if(typeof r?.calendar_collapsed=="boolean")return r.calendar_collapsed}}catch{}return!1}function de(e){const t=!!e;try{if(typeof localStorage>"u")return;localStorage.setItem(Q,t?"true":"false");const r=localStorage.getItem(j);let a={};if(r)try{a=JSON.parse(r)||{}}catch{a={}}a.calendar_collapsed=t,localStorage.setItem(j,JSON.stringify(a))}catch{}}function F(e){const t=!!e,r=document.getElementById("calendar-inline-body");r&&r.classList.toggle("hidden",t);const a=document.getElementById("btn-toggle-inline-calendar");a&&(a.textContent=t?"Expand":"Collapse",a.setAttribute("aria-expanded",t?"false":"true"))}const n={year:null,month:null,selectedDate:null,sportFilter:"All",activeLayers:new Set(["body_battery","sleep","steps","rhr_stress"]),inlineCollapsed:le(),modalOpen:!1,rollup:null,unit:"metric",latestDateStr:null,onOpenMetricTrend:null,initialized:!1};function B(e){const t=String(e?.type||e?.sport||e?.activity_type||"").toLowerCase();return t.includes("run")||t.includes("treadmill")||t.includes("trail")?"Running":t.includes("cycl")||t.includes("bik")||t.includes("ride")||t.includes("spin")?"Cycling":t.includes("strength")||t.includes("weight")||t.includes("gym")||t.includes("lift")?"Strength":t.includes("hik")||t.includes("mount")?"Hiking":t.includes("walk")?"Walking":"Other"}function S(e){const t=e?.date||e?.start_time||e?.timestamp||e?.calendar_date;if(!t||typeof t!="string")return null;const r=t.match(/^(\d{4}-\d{2}-\d{2})/);return r?r[1]:null}function W(e){const t=Math.max(0,Math.round(Number(e)||0));if(t===0)return"0m";const r=Math.floor(t/3600),a=Math.floor(t%3600/60);return r>0?a>0?`${r}h ${a}m`:`${r}h`:`${Math.max(1,a)}m`}function P(e,t="metric"){const r=Math.max(0,Number(e)||0);if(t==="imperial"||t==="mi"){const d=r/1609.344;return`${d.toFixed(d>=10?1:2)} mi`}const a=r/1e3;return`${a.toFixed(a>=10?1:2)} km`}function U(e){return typeof e?.distance_meters=="number"?e.distance_meters:typeof e?.distance_m=="number"?e.distance_m:typeof e?.distance_km=="number"?e.distance_km*1e3:typeof e?.distance=="number"?e.distance:0}function q(e){return typeof e?.duration_seconds=="number"?e.duration_seconds:typeof e?.moving_time_seconds=="number"?e.moving_time_seconds:typeof e?.duration_s=="number"?e.duration_s:typeof e?.duration_sec=="number"?e.duration_sec:typeof e?.duration_min=="number"?e.duration_min*60:typeof e?.duration=="number"?e.duration:0}function ce(e){return typeof e?.elevation_gain_meters=="number"?e.elevation_gain_meters:typeof e?.elevation_gain_m=="number"?e.elevation_gain_m:typeof e?.elevation_m=="number"?e.elevation_m:0}function ue(e){return typeof e?.tss=="number"?e.tss:typeof e?.training_stress_score=="number"?e.training_stress_score:0}function Y(e){return String(e).padStart(2,"0")}function pe(e,t,r){return`${e}-${Y(t+1)}-${Y(r)}`}function me(e,t,r=[],a=[],d="All",i=null){const s=new Map;for(const b of r||[]){if(d&&d!=="All"&&B(b)!==d)continue;const p=S(b);p&&(s.has(p)||s.set(p,[]),s.get(p).push(b))}const o=new Map;for(const b of a||[]){const p=S(b);p&&o.set(p,b)}const x=new Date(Date.UTC(e,t,1)),h=new Date(Date.UTC(e,t+1,0)).getUTCDate(),g=(x.getUTCDay()+6)%7,w=Math.ceil((g+h)/7)*7,c=[];for(let b=0;b<w;b+=7){const p=[];let M=0,A=0,D=0,L=0,l=0,v=0,y=0,T=0,f=0,H=0;for(let z=0;z<7;z++){const R=b+z-g+1,I=new Date(Date.UTC(e,t,R)),u=I.getUTCFullYear(),_=I.getUTCMonth(),m=I.getUTCDate(),E=pe(u,_,m),N=_===t&&u===e,O=s.get(E)||[],C=o.get(E)||null;for(const k of O)M+=1,A+=U(k),D+=q(k),L+=Number(k?.calories)||0,l+=ce(k),v+=ue(k);C&&(typeof C.sleep_score=="number"&&(y+=C.sleep_score,T+=1),typeof C.body_battery_high=="number"&&(f+=C.body_battery_high,H+=1)),p.push({dateStr:E,dayNum:m,inMonth:N,isToday:i?E===i:!1,activities:O,wellness:C})}c.push({days:p,summary:{activityCount:M,totalDistanceMeters:A,totalDurationSec:D,totalCalories:Math.round(L),totalElevationM:Math.round(l),totalTss:Math.round(v),avgSleepScore:T>0?Math.round(y/T):null,avgBodyBatteryPeak:H>0?Math.round(f/H):null}})}return c}function X(e){switch(e){case"Running":return"bg-emerald-500/15 text-emerald-300 border-emerald-500/30";case"Cycling":return"bg-sky-500/15 text-sky-300 border-sky-500/30";case"Strength":return"bg-amber-500/15 text-amber-300 border-amber-500/30";case"Hiking":return"bg-teal-500/15 text-teal-300 border-teal-500/30";case"Walking":return"bg-indigo-500/15 text-indigo-300 border-indigo-500/30";default:return"bg-purple-500/15 text-purple-300 border-purple-500/30"}}function ee(e){switch(e){case"Running":return"\u{1F3C3}";case"Cycling":return"\u{1F6B4}";case"Strength":return"\u{1F3CB}\uFE0F";case"Hiking":return"\u{1F97E}";case"Walking":return"\u{1F6B6}";default:return"\u26A1"}}function te(e){const t=Number(e);if(!Number.isFinite(t)||t<=0)return"--";const r=t>24?Math.round(t):Math.round(t*60),a=Math.floor(r/60),d=r%60;return`${a}h ${Y(d)}m`}function ne(e,t=!1){const{year:r,month:a,selectedDate:d,sportFilter:i,activeLayers:s,rollup:o,unit:x,latestDateStr:h}=n,g=o?.activities||[],w=o?.wellness?.daily||o?.wellness_daily||[],c=me(r,a,g,w,i,h),b=`${G[a]} ${r}`,p=new Set([r-1,r,r+1]);for(const l of g){const v=S(l);v&&p.add(Number(v.slice(0,4)))}const M=Array.from(p).sort((l,v)=>v-l),A=`
    <div class="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#2d2147]">
      <div class="flex items-center space-x-2">
        <button type="button" data-cal-action="prev-month" class="px-2.5 py-1.5 rounded-lg bg-[#1b132e] hover:bg-[#2d2147] text-zinc-200 border border-[#2d2147] text-xs font-semibold transition" aria-label="Previous Month">\u25C0</button>
        <div class="text-sm font-semibold text-white min-w-[130px] text-center">${b}</div>
        <button type="button" data-cal-action="next-month" class="px-2.5 py-1.5 rounded-lg bg-[#1b132e] hover:bg-[#2d2147] text-zinc-200 border border-[#2d2147] text-xs font-semibold transition" aria-label="Next Month">\u25B6</button>
        <select data-cal-action="select-year" class="bg-[#0b0714] border border-[#2d2147] rounded-lg px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-purple-400">
          ${M.map(l=>`<option value="${l}" ${l===r?"selected":""}>${l}</option>`).join("")}
        </select>
        <button type="button" data-cal-action="today" class="px-2.5 py-1.5 rounded-lg bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 border border-purple-500/30 text-xs font-semibold transition">Today</button>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        ${oe.map(l=>`
          <button
            type="button"
            data-cal-sport="${l}"
            class="px-2.5 py-1 rounded-full text-[11px] font-semibold border transition ${i===l?"bg-purple-500/25 text-white border-purple-400":"bg-[#130d21] text-zinc-400 border-[#2d2147] hover:text-zinc-200"}"
          >${l}</button>
        `).join("")}
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mr-1">Wellness Layers:</span>
        ${ie.map(l=>{const v=s.has(l.id);return`
            <button
              type="button"
              data-cal-layer="${l.id}"
              class="px-2.5 py-1 rounded-full text-[11px] font-medium border transition flex items-center space-x-1 ${v?"bg-emerald-500/15 text-emerald-300 border-emerald-500/35":"bg-[#130d21] text-zinc-500 border-[#2d2147] hover:text-zinc-300"}"
            >
              <span>${l.icon}</span>
              <span>${l.label}</span>
            </button>
          `}).join("")}
      </div>
    </div>
  `,D=`
    <div class="grid grid-cols-8 gap-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-400 pb-1.5">
      ${ae.map(l=>`<div class="text-center py-1">${l}</div>`).join("")}
      <div class="text-center py-1 text-purple-300">Week Summary</div>
    </div>
  `,L=c.map(l=>{const v=l.days.map(f=>{const z=d===f.dateStr?"border-purple-400 ring-1 ring-purple-400/50 bg-[#1b132e]":f.isToday?"border-emerald-500/50 bg-[#130d21]":"border-[#2d2147] bg-[#0e091a] hover:border-purple-500/40",V=f.inMonth?"":"opacity-45",R=f.activities.slice(0,3).map((m,E)=>{const N=B(m),O=U(m),C=q(m),k=O>0?P(O,x):W(C),se=m.id??m.activity_id??`${f.dateStr}-${E}`;return`
          <button
            type="button"
            data-cal-act-date="${f.dateStr}"
            data-cal-act-idx="${E}"
            data-cal-act-id="${se}"
            class="w-full text-left px-1.5 py-0.5 rounded border text-[10px] font-medium truncate flex items-center justify-between gap-1 transition hover:brightness-125 ${X(N)}"
            title="${m.name||N}"
          >
            <span class="truncate">${ee(N)} ${k}</span>
          </button>
        `}).join(""),I=f.activities.length>3?`<div class="text-[9px] text-zinc-400 font-mono pl-1">+${f.activities.length-3} more</div>`:"",u=f.wellness,_=[];if(u){if(s.has("body_battery")&&typeof u.body_battery_high=="number"){const m=typeof u.body_battery_low=="number"?u.body_battery_low:"--";_.push(`<span class="text-[9px] font-mono text-sky-300">\u26A1${u.body_battery_high}/${m}</span>`)}if(s.has("sleep")&&(typeof u.sleep_score=="number"||typeof u.sleep_duration_min=="number")){const m=typeof u.sleep_score=="number"?`${u.sleep_score}`:te(u.sleep_duration_min);_.push(`<span class="text-[9px] font-mono text-purple-300">\u{1F319}${m}</span>`)}if(s.has("steps")&&typeof u.steps=="number"){const m=u.steps>=1e3?`${(u.steps/1e3).toFixed(1)}k`:`${u.steps}`;_.push(`<span class="text-[9px] font-mono text-emerald-300">\u{1F463}${m}</span>`)}if(s.has("rhr_stress")&&(typeof u.resting_hr=="number"||typeof u.stress_avg=="number")){const m=typeof u.resting_hr=="number"?`${u.resting_hr}`:"--";_.push(`<span class="text-[9px] font-mono text-rose-300">\u2764\uFE0F${m}</span>`)}}return`
        <div
          data-cal-date="${f.dateStr}"
          role="button"
          tabindex="0"
          class="min-h-[88px] ${t?"sm:min-h-[108px]":""} p-1.5 rounded-lg border cursor-pointer transition flex flex-col justify-between ${z} ${V}"
        >
          <div class="flex items-center justify-between mb-1">
            <span class="text-[11px] font-mono font-semibold ${f.isToday?"text-emerald-400":"text-zinc-300"}">${f.dayNum}</span>
            ${f.isToday?'<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>':""}
          </div>
          <div class="space-y-1 flex-1">
            ${R}
            ${I}
          </div>
          ${_.length>0?`<div class="flex flex-wrap gap-x-1.5 gap-y-0.5 mt-1 pt-1 border-t border-[#2d2147]/60">${_.join("")}</div>`:""}
        </div>
      `}).join(""),y=l.summary,T=`
      <div class="min-h-[88px] ${t?"sm:min-h-[108px]":""} p-2 rounded-lg border border-[#2d2147] bg-[#130d21]/90 flex flex-col justify-between text-[10px]">
        <div class="font-mono font-semibold text-purple-300">${y.activityCount} ${y.activityCount===1?"workout":"workouts"}</div>
        <div class="space-y-0.5 text-zinc-300 font-mono">
          <div>${P(y.totalDistanceMeters,x)}</div>
          <div>${W(y.totalDurationSec)}</div>
          ${y.totalTss>0?`<div class="text-amber-300">${y.totalTss} TSS</div>`:`<div class="text-zinc-400">${y.totalCalories} kcal</div>`}
        </div>
        ${y.avgSleepScore!==null?`<div class="text-[9px] text-zinc-400 font-mono pt-1 border-t border-[#2d2147]/60">\u{1F319} ${y.avgSleepScore} avg</div>`:""}
      </div>
    `;return`<div class="grid grid-cols-8 gap-1.5">${v}${T}</div>`}).join("");return`
    ${A}
    <div class="overflow-x-auto">
      <div class="min-w-[680px] space-y-1.5">
        ${D}
        ${L}
      </div>
    </div>
    <div id="${e}-day-detail" class="pt-3 border-t border-[#2d2147]">
      ${fe()}
    </div>
  `}function fe(){const{selectedDate:e,rollup:t,unit:r,sportFilter:a}=n;if(!e)return'<div class="text-xs text-zinc-500 py-2">Select a day on the calendar to inspect workouts and daily wellness.</div>';const i=(t?.activities||[]).filter(c=>!(S(c)!==e||a&&a!=="All"&&B(c)!==a)),o=(t?.wellness?.daily||t?.wellness_daily||[]).find(c=>S(c)===e)||null,x=i.length>0?i.map((c,b)=>{const p=B(c),M=P(U(c),r),A=W(q(c)),D=c.avg_hr?`${Math.round(c.avg_hr)} bpm`:"--",L=c.calories?`${Math.round(c.calories)} kcal`:"--";return`
          <div
            data-cal-detail-act-idx="${b}"
            role="button"
            tabindex="0"
            class="p-3 rounded-xl bg-[#130d21] hover:bg-[#1b132e] border border-[#2d2147] hover:border-purple-500/40 cursor-pointer transition flex items-center justify-between gap-3"
          >
            <div class="flex items-center space-x-3 min-w-0">
              <span class="px-2 py-1 rounded-lg text-xs font-semibold border ${X(p)}">${ee(p)} ${p}</span>
              <div class="min-w-0">
                <div class="text-sm font-semibold text-white truncate">${c.title||c.name||p}</div>
                <div class="text-[11px] text-zinc-400 font-mono">${e}</div>
              </div>
            </div>
            <div class="flex items-center space-x-4 text-xs font-mono text-zinc-300 shrink-0">
              <span>${M}</span>
              <span>${A}</span>
              <span class="hidden sm:inline text-rose-300">${D}</span>
              <span class="hidden md:inline text-amber-300">${L}</span>
            </div>
          </div>
        `}).join(""):`<div class="text-xs text-zinc-500 py-2">No ${a!=="All"?a.toLowerCase()+" ":""}activities recorded on ${e}.</div>`,h=o?o.sleep_duration_min??(typeof o.sleep_seconds=="number"?Math.round(o.sleep_seconds/60):null):null,g=o?o.stress_level??o.stress_avg??"--":"--",w=o?`
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2">
      <div class="p-2.5 rounded-xl bg-[#130d21] border border-[#2d2147]">
        <div class="text-[10px] font-mono uppercase text-zinc-400">\u{1F319} Sleep</div>
        <div class="text-sm font-semibold text-purple-300 font-mono mt-0.5">${o.sleep_score??"--"} <span class="text-[11px] text-zinc-400">${te(h)}</span></div>
      </div>
      <div class="p-2.5 rounded-xl bg-[#130d21] border border-[#2d2147]">
        <div class="text-[10px] font-mono uppercase text-zinc-400">\u26A1 Body Battery</div>
        <div class="text-sm font-semibold text-sky-300 font-mono mt-0.5">${o.body_battery_high??"--"} / ${o.body_battery_low??"--"}</div>
      </div>
      <div class="p-2.5 rounded-xl bg-[#130d21] border border-[#2d2147]">
        <div class="text-[10px] font-mono uppercase text-zinc-400">\u{1F463} Steps</div>
        <div class="text-sm font-semibold text-emerald-300 font-mono mt-0.5">${typeof o.steps=="number"?o.steps.toLocaleString():"--"}</div>
      </div>
      <div class="p-2.5 rounded-xl bg-[#130d21] border border-[#2d2147]">
        <div class="text-[10px] font-mono uppercase text-zinc-400">\u2764\uFE0F RHR / Stress</div>
        <div class="text-sm font-semibold text-rose-300 font-mono mt-0.5">${o.resting_hr??"--"} bpm \u2022 ${g}</div>
      </div>
    </div>
  `:"";return`
    <div id="calendar-day-detail" class="space-y-2.5">
      <div class="flex items-center justify-between">
        <h3 class="text-xs font-mono uppercase tracking-wider text-purple-300">Selected Day: ${e}</h3>
        <span class="text-[11px] text-zinc-400 font-mono">${i.length} ${i.length===1?"activity":"activities"}</span>
      </div>
      <div class="space-y-2">${x}</div>
      ${w}
    </div>
  `}function re(e,t){if(!e)return;const r=e.querySelector('[data-cal-action="prev-month"]'),a=e.querySelector('[data-cal-action="next-month"]'),d=e.querySelector('[data-cal-action="select-year"]'),i=e.querySelector('[data-cal-action="today"]');r&&r.addEventListener("click",()=>{n.month===0?(n.month=11,n.year-=1):n.month-=1,$()}),a&&a.addEventListener("click",()=>{n.month===11?(n.month=0,n.year+=1):n.month+=1,$()}),d&&d.addEventListener("change",s=>{const o=Number(s.target.value);Number.isFinite(o)&&(n.year=o,$())}),i&&i.addEventListener("click",()=>{const s=n.latestDateStr||new Date().toISOString().slice(0,10),[o,x]=s.split("-").map(Number);n.year=o,n.month=x-1,n.selectedDate=s,$()}),e.querySelectorAll("[data-cal-sport]").forEach(s=>{s.addEventListener("click",()=>{n.sportFilter=s.getAttribute("data-cal-sport")||"All",$()})}),e.querySelectorAll("[data-cal-layer]").forEach(s=>{s.addEventListener("click",()=>{const o=s.getAttribute("data-cal-layer");o&&(n.activeLayers.has(o)?n.activeLayers.delete(o):n.activeLayers.add(o),$())})}),e.querySelectorAll("[data-cal-date]").forEach(s=>{s.addEventListener("click",()=>{n.selectedDate=s.getAttribute("data-cal-date"),$()})}),e.querySelectorAll("[data-cal-act-date]").forEach(s=>{s.addEventListener("click",o=>{typeof o.stopPropagation=="function"&&o.stopPropagation();const x=s.getAttribute("data-cal-act-date"),h=Number(s.getAttribute("data-cal-act-idx")),w=(n.rollup?.activities||[]).filter(c=>!(S(c)!==x||n.sportFilter!=="All"&&B(c)!==n.sportFilter))[h];w&&Z(w,n.unit)})}),e.querySelectorAll("[data-cal-detail-act-idx]").forEach(s=>{s.addEventListener("click",()=>{const o=Number(s.getAttribute("data-cal-detail-act-idx")),h=(n.rollup?.activities||[]).filter(g=>!(S(g)!==n.selectedDate||n.sportFilter!=="All"&&B(g)!==n.sportFilter))[o];h&&Z(h,n.unit)})})}function $(){if(!n.rollup)return;const e=document.getElementById("calendar-month-badge");e&&n.year!==null&&n.month!==null&&(e.textContent=`${G[n.month].toUpperCase()} ${n.year}`);const t=document.getElementById("calendar-inline-body");t&&!n.inlineCollapsed&&(t.innerHTML=ne("calendar-inline",!1),re(t,!1));const r=document.getElementById("calendar-modal-body");r&&n.modalOpen&&(r.innerHTML=ne("calendar-modal",!0),re(r,!0))}function ye({onOpenMetricTrend:e}={}){if(e&&(n.onOpenMetricTrend=e),n.initialized)return;n.initialized=!0;const t=document.getElementById("btn-header-calendar");t&&t.addEventListener("click",()=>J());const r=document.getElementById("btn-open-calendar-modal");r&&r.addEventListener("click",()=>J());const a=document.getElementById("btn-toggle-inline-calendar");a&&(F(n.inlineCollapsed),a.addEventListener("click",()=>{n.inlineCollapsed=!n.inlineCollapsed,de(n.inlineCollapsed),F(n.inlineCollapsed),n.inlineCollapsed||$()}));const d=document.getElementById("btn-close-calendar-modal");d&&d.addEventListener("click",()=>K());const i=document.getElementById("calendar-modal");i&&i.addEventListener("click",s=>{s.target===i&&K()}),document.addEventListener("click",s=>{s.target&&typeof s.target.closest=="function"&&s.target.closest('[data-open-calendar="true"]')&&J()}),document.addEventListener("keydown",s=>{s.key==="Escape"&&n.modalOpen&&K()})}function xe(e,t="metric"){if(!e)return;n.rollup=e,n.unit=t;let r=null;for(const d of e.activities||[]){const i=S(d);i&&(!r||i>r)&&(r=i)}for(const d of e.wellness?.daily||e.wellness_daily||[]){const i=S(d);i&&(!r||i>r)&&(r=i)}if(n.latestDateStr=r||new Date().toISOString().slice(0,10),n.year===null||n.month===null){const[d,i]=n.latestDateStr.split("-").map(Number);n.year=d,n.month=i-1,n.selectedDate=n.latestDateStr}const a=document.getElementById("calendar-section");a&&a.classList.remove("hidden"),F(n.inlineCollapsed),$()}function J(){const e=document.getElementById("calendar-modal");e&&(n.modalOpen=!0,e.classList.remove("hidden"),e.setAttribute("aria-hidden","false"),$())}function K(){const e=document.getElementById("calendar-modal");e&&(n.modalOpen=!1,e.classList.add("hidden"),e.setAttribute("aria-hidden","true"))}function ge(){n.rollup=null,n.selectedDate=null,n.latestDateStr=null}export{oe as CALENDAR_SPORT_FILTERS,ie as WELLNESS_LAYERS,F as applyCalendarCollapsedState,me as buildCalendarWeeks,ge as clearCalendarCache,K as closeCalendarModal,S as extractDateStr,P as formatCalendarDistance,W as formatCalendarDuration,ye as initCalendar,le as loadCalendarCollapsedState,B as normalizeSportCategory,J as openCalendarModal,xe as renderCalendar,de as saveCalendarCollapsedState};
