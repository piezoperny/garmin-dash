const N={in_focus:["sleep","body_battery","stress","steps"],at_a_glance:["resting_hr","hrv","intensity_minutes","calories"],hidden:[]},G={steps:{id:"card-wellness-steps",name:"Daily Steps",defaultSection:"in_focus"},resting_hr:{id:"card-wellness-rhr",name:"Resting Heart Rate",defaultSection:"at_a_glance"},sleep:{id:"card-wellness-sleep",name:"Sleep",defaultSection:"in_focus"},stress:{id:"card-wellness-stress",name:"Stress",defaultSection:"in_focus"},body_battery:{id:"card-wellness-body-battery",name:"Body Battery",defaultSection:"in_focus"},hrv:{id:"card-wellness-hrv",name:"HRV Status",defaultSection:"at_a_glance"},intensity_minutes:{id:"card-wellness-intensity",name:"Active Intensity Minutes",defaultSection:"at_a_glance"},calories:{id:"card-wellness-calories",name:"Daily Calories",defaultSection:"at_a_glance"},training_readiness:{id:"card-wellness-training-readiness",name:"Training Readiness",defaultSection:"readiness_vitals"},vo2max:{id:"card-wellness-vo2max",name:"VO2 Max",defaultSection:"readiness_vitals"},spo2:{id:"card-wellness-spo2",name:"Pulse Ox (SpO2)",defaultSection:"readiness_vitals"},respiration:{id:"card-wellness-respiration",name:"Respiration Rate",defaultSection:"readiness_vitals"},floors:{id:"card-wellness-floors",name:"Floors Climbed",defaultSection:"readiness_vitals"},hydration:{id:"card-wellness-hydration",name:"Hydration",defaultSection:"readiness_vitals"},weight:{id:"card-wellness-weight",name:"Weight & Body Comp",defaultSection:"readiness_vitals"}};import{openMetricTrendModal as T}from"./trends_modal.js";let b=null;function O(){return typeof window>"u"?!1:"ontouchstart"in window||typeof navigator<"u"&&navigator.maxTouchPoints>0}function x(){return O()?"":'draggable="true"'}function C(e){if(!e)return null;let s=String(e).replace("card-wellness-","").toLowerCase().trim();return s==="rhr"&&(s="resting_hr"),s==="intensity"&&(s="intensity_minutes"),G[s]?s:null}function B(){try{const e=typeof localStorage<"u"?localStorage:typeof sessionStorage<"u"?sessionStorage:null;if(!e)return JSON.parse(JSON.stringify(N));const s=e.getItem("garmin_dash_customization");if(!s)return JSON.parse(JSON.stringify(N));const n=JSON.parse(s);if(!n||typeof n!="object"||!n.wellness_layout)return JSON.parse(JSON.stringify(N));const t=n.wellness_layout;let i=(Array.isArray(t.in_focus)?t.in_focus:[]).map(C).filter(Boolean),l=(Array.isArray(t.at_a_glance)?t.at_a_glance:[]).map(C).filter(Boolean),a=(Array.isArray(t.hidden)?t.hidden:[]).map(C).filter(Boolean);const o=new Set;return i=i.filter(r=>!o.has(r)&&o.add(r)),l=l.filter(r=>!o.has(r)&&o.add(r)),a=a.filter(r=>!o.has(r)&&o.add(r)),i.length===3&&i[0]==="sleep"&&i[1]==="body_battery"&&i[2]==="steps"&&l.length===5&&l[0]==="resting_hr"&&l[1]==="stress"&&l[2]==="hrv"&&l[3]==="intensity_minutes"&&l[4]==="calories"&&a.length===0?JSON.parse(JSON.stringify(N)):{in_focus:i,at_a_glance:l,hidden:a}}catch{return JSON.parse(JSON.stringify(N))}}function R(e){try{const s=typeof localStorage<"u"?localStorage:typeof sessionStorage<"u"?sessionStorage:null;if(!s)return;let n={hidden_cards:[],thresholds:{}};try{const t=s.getItem("garmin_dash_customization");if(t){const i=JSON.parse(t);i&&typeof i=="object"&&(n=i)}}catch{}n.wellness_layout=e,s.setItem("garmin_dash_customization",JSON.stringify(n))}catch{}}function re(){R(JSON.parse(JSON.stringify(N))),b&&I(b)}function W(e,s){const n=C(e);if(!n)return;const t=B(),i=t.in_focus.includes(n),l=t.at_a_glance.includes(n);if(s==="remove")t.in_focus=t.in_focus.filter(a=>a!==n),t.at_a_glance=t.at_a_glance.filter(a=>a!==n),t.hidden.includes(n)||t.hidden.push(n);else if(s==="toggle-section")i?(t.in_focus=t.in_focus.filter(a=>a!==n),t.at_a_glance.push(n)):l&&(t.at_a_glance=t.at_a_glance.filter(a=>a!==n),t.in_focus.push(n));else{const a=i?t.in_focus:l?t.at_a_glance:null;if(a){const o=a.indexOf(n),r=s==="up"||s==="prev"?o-1:o+1;r>=0&&r<a.length&&(a.splice(o,1),a.splice(r,0,n))}}R(t),b&&I(b)}function de(e,s="at_a_glance"){const n=C(e);if(!n)return;const t=B();t.hidden=t.hidden.filter(i=>i!==n),t.in_focus=t.in_focus.filter(i=>i!==n),t.at_a_glance=t.at_a_glance.filter(i=>i!==n),s==="in_focus"?t.in_focus.push(n):t.at_a_glance.push(n),R(t),b&&I(b)}function E(e){return e==null?"\u2014":Number(e).toLocaleString()}function h(e){if(e==null)return"\u2014";const s=Number(e)||0,n=Math.floor(s/3600),t=Math.floor(s%3600/60);return`${n}h ${t}m`}function A(e){return e==null?"\u2014":Number(e).toLocaleString()}function y(e){const s=String(e||"").toLowerCase();return s.includes("good")||s.includes("balanced")||s.includes("low")||s.includes("optimal")?"text-emerald-400 border-emerald-500/30 bg-emerald-500/10":s.includes("fair")||s.includes("medium")||s.includes("moderate")?"text-amber-400 border-amber-500/30 bg-amber-500/10":s.includes("poor")||s.includes("unbalanced")||s.includes("high")?"text-rose-400 border-rose-500/30 bg-rose-500/10":"text-cyan-400 border-cyan-500/30 bg-cyan-500/10"}function q(e,s="#10b981",n=24,t=72){if(!e||e.length===0)return"";const i=Math.max(...e,1),l=Math.max(3,Math.floor((t-(e.length-1)*3)/e.length)),a=e.map((o,d)=>{const r=Math.max(3,Math.round((o||0)/i*(n-4))),f=d*(l+3),u=n-r,c=d===e.length-1;return`<rect x="${f}" y="${u}" width="${l}" height="${r}" rx="1.5" fill="${s}" opacity="${c?"1":"0.45"}"/>`}).join("");return`<svg width="${t}" height="${n}" viewBox="0 0 ${t} ${n}" class="overflow-visible shrink-0">${a}</svg>`}function V(e,s="#f43f5e",n=24,t=72){if(!e||e.length<2)return"";const i=Math.min(...e),a=Math.max(...e,i+1)-i||1,o=t/(e.length-1),d=e.map((r,f)=>{const u=Math.round(f*o),c=Math.round(n-4-((r||i)-i)/a*(n-8));return`${u},${c}`}).join(" ");return`
    <svg width="${t}" height="${n}" viewBox="0 0 ${t} ${n}" class="overflow-visible shrink-0">
      <polyline fill="none" stroke="${s}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${d}"/>
    </svg>
  `}function U(e,s=22,n=4,t="#10b981"){const i=Math.min(100,Math.max(0,e||0)),l=2*Math.PI*s,a=l-i/100*l,o=(s+n)*2;return`
    <svg width="${o}" height="${o}" viewBox="0 0 ${o} ${o}" class="transform -rotate-90 shrink-0">
      <circle cx="${s+n}" cy="${s+n}" r="${s}" stroke="#3b2b5e" stroke-width="${n}" fill="none"/>
      <circle cx="${s+n}" cy="${s+n}" r="${s}" stroke="${t}" stroke-width="${n}" stroke-linecap="round" fill="none" stroke-dasharray="${l}" stroke-dashoffset="${a}"/>
    </svg>
  `}function p(e,s){return`
    <div class="flex items-center space-x-1 ${O()?"opacity-80":"opacity-0 group-hover:opacity-100"} transition-opacity">
      <button type="button" data-wellness-action="prev" data-metric="${e}" title="Move earlier" class="p-1 rounded bg-[#1b132e] hover:bg-[#3b2b5e] text-zinc-400 hover:text-white text-[10px] leading-none transition">
        \u25C0
      </button>
      <button type="button" data-wellness-action="next" data-metric="${e}" title="Move later" class="p-1 rounded bg-[#1b132e] hover:bg-[#3b2b5e] text-zinc-400 hover:text-white text-[10px] leading-none transition">
        \u25B6
      </button>
      <button type="button" data-wellness-action="toggle-section" data-metric="${e}" title="${s?"Move to At a Glance":"Promote to In Focus"}" class="p-1 rounded bg-[#1b132e] hover:bg-[#3b2b5e] text-zinc-400 hover:text-white text-[10px] leading-none transition">
        ${s?"\u25BC":"\u25B2"}
      </button>
      <button type="button" data-wellness-action="remove" data-metric="${e}" title="Remove card" class="p-1 rounded bg-[#1b132e] hover:bg-rose-950/40 text-zinc-400 hover:text-rose-400 text-[10px] leading-none transition">
        \u2715
      </button>
    </div>
  `}function Q(e,s,n){const t=e.steps||0,i=e.steps_goal||1e4,l=Math.round(t/i*100),a=(s||[]).slice(-7).map(o=>o.steps||0);return n?`
      <div id="card-wellness-steps" ${x()} data-metric="steps" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span>Daily Steps</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${E(t)}</div>
            <div class="text-[11px] text-zinc-400 mt-1">Goal: ${E(i)} (${l}%)</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${p("steps",!0)}
            ${U(l,24,4,"#10b981")}
          </div>
        </div>
        <div class="pt-4 mt-3 border-t border-[#2d2147] flex items-center justify-between">
          <span class="text-[11px] text-zinc-500">7-Day Daily Steps</span>
          ${q(a,"#10b981",22,90)}
        </div>
      </div>
    `:`
    <div id="card-wellness-steps" ${x()} data-metric="steps" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Steps</span>
        ${p("steps",!1)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${E(t)}</div>
        <div class="text-[10px] text-zinc-400 mt-0.5">${l}% of ${E(i)}</div>
      </div>
      <div class="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
        <div class="bg-emerald-500 h-full rounded-full" style="width: ${Math.min(100,l)}%"></div>
      </div>
    </div>
  `}function Y(e,s,n){const t=e.resting_hr||e.resting_heart_rate||48,i=e.resting_hr_7d_avg||49,l=(s||[]).slice(-7).map(a=>a.resting_hr||a.resting_heart_rate||48);return n?`
      <div id="card-wellness-rhr" ${x()} data-metric="resting_hr" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-rose-500"></span>
              <span>Resting Heart Rate</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${t} <span class="text-sm font-sans font-normal text-zinc-500">bpm</span></div>
            <div class="text-[11px] text-zinc-400 mt-1">7-Day Avg: ${i} bpm</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${p("resting_hr",!0)}
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border ${y("Optimal")}">Optimal</span>
          </div>
        </div>
        <div class="pt-4 mt-3 border-t border-[#2d2147] flex items-center justify-between">
          <span class="text-[11px] text-zinc-500">7-Day Trend</span>
          ${V(l,"#f43f5e",22,90)}
        </div>
      </div>
    `:`
    <div id="card-wellness-rhr" ${x()} data-metric="resting_hr" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Resting HR</span>
        ${p("resting_hr",!1)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${t} <span class="text-xs font-normal text-zinc-500">bpm</span></div>
        <div class="text-[10px] text-zinc-400 mt-0.5">7d avg: ${i} bpm</div>
      </div>
      <span class="inline-block self-start px-2 py-0.5 rounded text-[10px] font-semibold border ${y("Optimal")}">Optimal</span>
    </div>
  `}function X(e,s,n){const t=e.sleep_seconds||27900,i=e.sleep_score||88,l=e.sleep_quality||"Good",a=e.sleep_deep_seconds||6300,o=e.sleep_light_seconds||16200,d=e.sleep_rem_seconds||5400,r=e.sleep_awake_seconds||1800,f=Math.max(1,a+o+d+r);if(n){const u=(a/f*100).toFixed(1),c=(o/f*100).toFixed(1),v=(d/f*100).toFixed(1),m=(r/f*100).toFixed(1);return`
      <div id="card-wellness-sleep" ${x()} data-metric="sleep" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-indigo-400"></span>
              <span>Sleep</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${h(t)}</div>
            <div class="text-[11px] text-zinc-400 mt-1">Score: ${i}/100 \u2022 ${l}</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${p("sleep",!0)}
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border ${y(l)}">${l}</span>
          </div>
        </div>

        <div class="pt-4 mt-3 border-t border-[#2d2147] space-y-2">
          <div class="flex items-center justify-between text-[11px] text-zinc-400">
            <span>Sleep Stages</span>
            <span class="text-zinc-500 font-mono text-[10px]">Deep ${h(a)} \u2022 REM ${h(d)}</span>
          </div>
          <div class="w-full bg-zinc-800 rounded-full h-2.5 flex overflow-hidden">
            <div style="width: ${u}%" class="bg-indigo-600 h-full" title="Deep: ${h(a)}"></div>
            <div style="width: ${c}%" class="bg-indigo-400 h-full" title="Light: ${h(o)}"></div>
            <div style="width: ${v}%" class="bg-violet-400 h-full" title="REM: ${h(d)}"></div>
            <div style="width: ${m}%" class="bg-rose-500 h-full" title="Awake: ${h(r)}"></div>
          </div>
        </div>
      </div>
    `}return`
    <div id="card-wellness-sleep" ${x()} data-metric="sleep" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Sleep</span>
        ${p("sleep",!1)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${h(t)}</div>
        <div class="text-[10px] text-zinc-400 mt-0.5">Score: ${i} (${l})</div>
      </div>
      <span class="inline-block self-start px-2 py-0.5 rounded text-[10px] font-semibold border ${y(l)}">${l}</span>
    </div>
  `}function _(e,s=null){if(e==null||e===""||typeof e=="boolean")return s;const n=Number(e);return Number.isFinite(n)?n:s}function D(e){const s=Math.max(0,Math.round(_(e,0))),n=Math.floor(s/3600),t=Math.floor(s%3600/60);return n>0&&t>0?`${n}h ${t}m`:n>0?`${n}h`:`${t}m`}function Z(e){return e<=25?"Rest":e<=50?"Low":e<=75?"Medium":"High"}function K(e,s,n){const t=_(e?.stress_level,24),i=Math.max(0,Math.min(100,Math.round(t))),l=e?.stress_qualifier||e?.stress_status||Z(i),a=_(e?.stress_max,null),o=_(e?.stress_rest_seconds,null),d=_(e?.stress_low_seconds,null),r=_(e?.stress_medium_seconds,null),f=_(e?.stress_high_seconds,null),u=o!==null||d!==null||r!==null||f!==null;let c,v,m,w,$,z,S,M;if(u){const k=Math.max(0,o??0),L=Math.max(0,d??0),j=Math.max(0,r??0),F=Math.max(0,f??0),g=k+L+j+F;g>0?(c=Number((k/g*100).toFixed(1)),v=Number((L/g*100).toFixed(1)),m=Number((j/g*100).toFixed(1)),w=Number(Math.max(0,100-c-v-m).toFixed(1))):(c=100,v=0,m=0,w=0),$=D(k),z=D(L),S=D(j),M=D(F)}else{const k=Math.max(5,100-i*1.15),L=Math.max(5,65-Math.abs(i-38)*.9),j=Math.max(4,55-Math.abs(i-63)*.95),F=Math.max(2,i>50?(i-40)*.85:i*.12),g=k+L+j+F;c=Number((k/g*100).toFixed(1)),v=Number((L/g*100).toFixed(1)),m=Number((j/g*100).toFixed(1)),w=Number(Math.max(0,100-c-v-m).toFixed(1)),$=`${Math.round(c)}%`,z=`${Math.round(v)}%`,S=`${Math.round(m)}%`,M=`${Math.round(w)}%`}const H=i<=25?"#38bdf8":i<=50?"#fbbf24":i<=75?"#f97316":"#f43f5e",J=a!==null?` \u2022 Peak: ${Math.round(a)}`:"";return n?`
      <div id="card-wellness-stress" ${x()} data-metric="stress" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full" style="background-color: ${H};"></span>
              <span>Stress</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${i} <span class="text-sm font-sans font-normal text-zinc-500">/ 100</span></div>
            <div class="text-[11px] text-zinc-400 mt-1">${l} Stress Level${J}</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${p("stress",!0)}
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border ${y(l)}">${l}</span>
          </div>
        </div>

        <div class="pt-4 mt-3 border-t border-[#2d2147] space-y-2">
          <div class="w-full bg-zinc-900 rounded-full h-2.5 overflow-hidden flex">
            <div style="width: ${c}%; background-color: #38bdf8;" title="Rest: ${$}"></div>
            <div style="width: ${v}%; background-color: #fbbf24;" title="Low: ${z}"></div>
            <div style="width: ${m}%; background-color: #f97316;" title="Med: ${S}"></div>
            <div style="width: ${w}%; background-color: #f43f5e;" title="High: ${M}"></div>
          </div>
          <div class="grid grid-cols-4 gap-1 text-[10px] text-zinc-400 font-mono">
            <div class="flex items-center space-x-1">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" style="background-color: #38bdf8;"></span>
              <span class="truncate">Rest ${$}</span>
            </div>
            <div class="flex items-center space-x-1">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" style="background-color: #fbbf24;"></span>
              <span class="truncate">Low ${z}</span>
            </div>
            <div class="flex items-center space-x-1">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" style="background-color: #f97316;"></span>
              <span class="truncate">Med ${S}</span>
            </div>
            <div class="flex items-center space-x-1">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" style="background-color: #f43f5e;"></span>
              <span class="truncate">High ${M}</span>
            </div>
          </div>
        </div>
      </div>
    `:`
    <div id="card-wellness-stress" ${x()} data-metric="stress" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Stress</span>
        ${p("stress",!1)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${i} <span class="text-xs font-normal text-zinc-500">/ 100</span></div>
        <div class="text-[10px] text-zinc-400 mt-0.5">${l} Stress</div>
      </div>
      <span class="inline-block self-start px-2 py-0.5 rounded text-[10px] font-semibold border ${y(l)}">${l}</span>
    </div>
  `}function ee(e,s,n){const t=e.body_battery??e.body_battery_high??null,i=typeof t=="number"&&Number.isFinite(t)?t:null,l=e.body_battery_charged??e.charged??null,a=e.body_battery_drained??e.drained??null,o=typeof l=="number"&&Number.isFinite(l)?l:null,d=typeof a=="number"&&Number.isFinite(a)?a:null,r=i!==null?i:"\u2014",f=o!==null?`+${o}`:"\u2014",u=d!==null?`-${d}`:"\u2014",c=i!==null?Math.min(100,Math.max(0,i)):0;return n?`
      <div id="card-wellness-body-battery" ${x()} data-metric="body_battery" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-cyan-400"></span>
              <span>Body Battery</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${r} <span class="text-sm font-sans font-normal text-zinc-500">/ 100</span></div>
            <div class="text-[11px] text-zinc-400 mt-1">Charged: ${f} \u2022 Drained: ${u}</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${p("body_battery",!0)}
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border border-cyan-500/30 text-cyan-400 bg-cyan-500/10">${i!==null?"Active":"No Data"}</span>
          </div>
        </div>

        <div class="pt-4 mt-3 border-t border-[#2d2147] space-y-1.5">
          <div class="flex justify-between text-[11px] text-zinc-400">
            <span>Battery Level</span>
            <span class="font-mono text-[10px] text-cyan-400">${i!==null?`${i}%`:"\u2014"}</span>
          </div>
          <div class="w-full bg-zinc-800 rounded-full h-2.5 overflow-hidden">
            <div class="bg-gradient-to-r from-cyan-600 to-cyan-400 h-full rounded-full" style="width: ${c}%"></div>
          </div>
        </div>
      </div>
    `:`
    <div id="card-wellness-body-battery" ${x()} data-metric="body_battery" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Body Battery</span>
        ${p("body_battery",!1)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${r} <span class="text-xs font-normal text-zinc-500">/ 100</span></div>
        <div class="text-[10px] text-zinc-400 mt-0.5">${f} / ${u}</div>
      </div>
      <div class="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
        <div class="bg-cyan-400 h-full rounded-full" style="width: ${c}%"></div>
      </div>
    </div>
  `}function te(e,s,n){const t=e.hrv_status??"\u2014",i=e.hrv_weekly_avg??e.hrv_7d_avg??"\u2014",l=e.hrv_last_night_avg??e.hrv_ms??"\u2014";let a=50;const o=typeof i=="number"?i:typeof l=="number"?l:null;if(o!==null&&e.hrv_baseline&&typeof e.hrv_baseline.low=="number"&&typeof e.hrv_baseline.high=="number"&&e.hrv_baseline.high>e.hrv_baseline.low){const d=e.hrv_baseline.high-e.hrv_baseline.low,r=(o-(e.hrv_baseline.low-d*.5))/(d*2);a=Math.round(Math.max(4,Math.min(96,r*100)))}return n?`
      <div id="card-wellness-hrv" ${x()} data-metric="hrv" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-teal-400"></span>
              <span>HRV Status</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${i} <span class="text-sm font-sans font-normal text-zinc-500">ms</span></div>
            <div class="text-[11px] text-zinc-400 mt-1">Last Night: ${l} ms (7d avg: ${i} ms)</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${p("hrv",!0)}
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border ${y(t)}">${t}</span>
          </div>
        </div>

        <div class="pt-4 mt-3 border-t border-[#2d2147] space-y-1.5">
          <div class="flex justify-between text-[11px] text-zinc-400">
            <span>Baseline Status</span>
            <span class="text-teal-400 text-[10px] font-semibold">${t}</span>
          </div>
          <div class="w-full bg-zinc-800 rounded-full h-2 relative overflow-hidden flex">
            <div class="w-1/3 bg-amber-500/20"></div>
            <div class="w-1/3 bg-emerald-500/40"></div>
            <div class="w-1/3 bg-amber-500/20"></div>
            <div class="absolute top-0 bottom-0 w-2 bg-teal-300 rounded-full" style="left: calc(${a}% - 4px)"></div>
          </div>
        </div>
      </div>
    `:`
    <div id="card-wellness-hrv" ${x()} data-metric="hrv" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">HRV Status</span>
        ${p("hrv",!1)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${i} <span class="text-xs font-normal text-zinc-500">ms</span></div>
        <div class="text-[10px] text-zinc-400 mt-0.5">Last night: ${l} ms</div>
      </div>
      <span class="inline-block self-start px-2 py-0.5 rounded text-[10px] font-semibold border ${y(t)}">${t}</span>
    </div>
  `}function se(e,s,n){const t=e.intensity_minutes_weekly||e.active_intensity_minutes||52,i=e.intensity_minutes_goal||150,l=Math.round(t/i*100),a=e.intensity_minutes_moderate||Math.round(t*.6),o=e.intensity_minutes_vigorous||Math.round(t*.4);return n?`
      <div id="card-wellness-intensity" ${x()} data-metric="intensity_minutes" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-lime-400"></span>
              <span>Active Intensity Minutes</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${t} <span class="text-sm font-sans font-normal text-zinc-500">min/wk</span></div>
            <div class="text-[11px] text-zinc-400 mt-1">Goal: ${i} min (${l}%)</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${p("intensity_minutes",!0)}
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border ${l>=100?"text-lime-400 border-lime-500/30 bg-lime-500/10":"text-zinc-400 border-zinc-700 bg-zinc-800"}">${l>=100?"Goal Met":"In Progress"}</span>
          </div>
        </div>

        <div class="pt-4 mt-3 border-t border-[#2d2147] space-y-1.5">
          <div class="flex justify-between text-[11px] text-zinc-400">
            <span>Moderate (${a}m) \u2022 Vigorous (${o}m)</span>
            <span class="text-lime-400 font-mono text-[10px]">${l}%</span>
          </div>
          <div class="w-full bg-zinc-800 rounded-full h-2.5 overflow-hidden">
            <div class="bg-lime-400 h-full rounded-full" style="width: ${Math.min(100,l)}%"></div>
          </div>
        </div>
      </div>
    `:`
    <div id="card-wellness-intensity" ${x()} data-metric="intensity_minutes" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Intensity Min</span>
        ${p("intensity_minutes",!1)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${t} <span class="text-xs font-normal text-zinc-500">min</span></div>
        <div class="text-[10px] text-zinc-400 mt-0.5">${l}% of ${i}m goal</div>
      </div>
      <div class="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
        <div class="bg-lime-400 h-full rounded-full" style="width: ${Math.min(100,l)}%"></div>
      </div>
    </div>
  `}function ne(e,s,n){const t=e.daily_calories||2410,i=e.active_calories||680,l=e.bmr_calories||Math.max(0,t-i),a=Math.round(i/Math.max(1,t)*100);return n?`
      <div id="card-wellness-calories" ${x()} data-metric="calories" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-5 flex flex-col justify-between group transition relative hover:border-zinc-700">
        <div class="flex items-start justify-between">
          <div>
            <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <span class="w-2 h-2 rounded-full bg-orange-400"></span>
              <span>Daily Calories</span>
            </div>
            <div class="text-3xl font-bold font-mono text-white mt-1.5 tabular-nums">${A(t)} <span class="text-sm font-sans font-normal text-zinc-500">kcal</span></div>
            <div class="text-[11px] text-zinc-400 mt-1">Active: ${A(i)} \u2022 Resting: ${A(l)}</div>
          </div>
          <div class="flex flex-col items-end space-y-2">
            ${p("calories",!0)}
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border text-orange-400 border-orange-500/30 bg-orange-500/10">${a}% Active</span>
          </div>
        </div>

        <div class="pt-4 mt-3 border-t border-[#2d2147] space-y-1.5">
          <div class="flex justify-between text-[11px] text-zinc-400">
            <span>Calorie Burn Split</span>
            <span class="font-mono text-[10px] text-orange-400">${i} Active / ${l} BMR</span>
          </div>
          <div class="w-full bg-zinc-800 rounded-full h-2.5 flex overflow-hidden">
            <div class="bg-orange-500 h-full" style="width: ${a}%" title="Active: ${i} kcal"></div>
            <div class="bg-zinc-700 h-full flex-1" title="Resting: ${l} kcal"></div>
          </div>
        </div>
      </div>
    `:`
    <div id="card-wellness-calories" ${x()} data-metric="calories" class="bg-[#130d21] border border-[#2d2147] rounded-xl p-4 flex flex-col justify-between group transition relative hover:border-zinc-700">
      <div class="flex items-start justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Calories</span>
        ${p("calories",!1)}
      </div>
      <div class="my-2">
        <div class="text-xl font-bold font-mono text-white tabular-nums">${A(t)} <span class="text-xs font-normal text-zinc-500">kcal</span></div>
        <div class="text-[10px] text-zinc-400 mt-0.5">Active: ${A(i)} kcal</div>
      </div>
      <div class="w-full bg-zinc-800 rounded-full h-1.5 flex overflow-hidden">
        <div class="bg-orange-500 h-full" style="width: ${a}%"></div>
        <div class="bg-zinc-700 h-full flex-1"></div>
      </div>
    </div>
  `}function P(e,s,n,t){switch(e){case"steps":return Q(s,n,t);case"resting_hr":return Y(s,n,t);case"sleep":return X(s,n,t);case"stress":return K(s,n,t);case"body_battery":return ee(s,n,t);case"hrv":return te(s,n,t);case"intensity_minutes":return se(s,n,t);case"calories":return ne(s,n,t);default:return""}}function I(e,s="wellness-dashboard"){if(!e)return;b=e;const n=document.getElementById(s)||document.getElementById("wellness-dashboard"),t=document.getElementById("wellness-in-focus"),i=document.getElementById("wellness-at-a-glance"),l="wellness-empty-notice";let a=document.getElementById(l);const o=e?.wellness?.current;if(!!!(o&&typeof o=="object"&&Object.keys(o).length>0)){t&&(t.innerHTML="",t.style&&(t.style.display="none")),i&&(i.innerHTML="",i.style&&(i.style.display="none"));const c=document.getElementById("wellness-readiness-vitals");c&&(c.innerHTML="",c.style&&(c.style.display="none")),n&&(a||(a=document.createElement("div"),a.id=l,a.className="border border-dashed border-[#2d2147] rounded-xl p-8 text-center flex flex-col items-center justify-center space-y-3",a.innerHTML=`
          <div class="w-10 h-10 rounded-full bg-zinc-900 border border-[#2d2147] flex items-center justify-center mb-1">
            <svg class="w-5 h-5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z"/>
            </svg>
          </div>
          <p class="text-xs font-semibold text-zinc-300">No Synced Garmin Wellness Metrics Available</p>
          <p class="text-xs text-zinc-500 max-w-md">No synced Garmin wellness metrics available. Sync with Garmin Connect to view daily wellness data.</p>
        `,n.appendChild(a)),a.classList&&typeof a.classList.remove=="function"&&a.classList.remove("hidden"),a.style&&(a.style.display="flex"));return}a&&(a.classList&&typeof a.classList.add=="function"&&a.classList.add("hidden"),a.style&&(a.style.display="none")),t&&t.style&&(t.style.display=""),i&&i.style&&(i.style.display="");const r=e?.wellness?.daily||[],f=B();t&&(f.in_focus.length===0?t.innerHTML=`
        <div class="col-span-full border border-dashed border-[#2d2147] rounded-xl p-6 text-center text-zinc-500 text-xs">
          No cards currently In Focus. Click "Edit Cards" or use the quick action buttons to promote priority metrics.
        </div>
      `:t.innerHTML=f.in_focus.map(c=>P(c,o,r,!0)).join("")),i&&(f.at_a_glance.length===0?i.innerHTML=`
        <div class="col-span-full border border-dashed border-[#2d2147] rounded-xl p-4 text-center text-zinc-500 text-xs">
          No cards in At a Glance.
        </div>
      `:i.innerHTML=f.at_a_glance.map(c=>P(c,o,r,!1)).join(""));let u=document.getElementById("wellness-readiness-vitals");!u&&n&&typeof document<"u"&&(u=document.createElement("div"),u.id="wellness-readiness-vitals",u.className="grid grid-cols-1 lg:grid-cols-12 gap-4",n.appendChild(u)),u&&(u.style&&(u.style.display=""),u.innerHTML=ie(o)),le(),ae()}function ie(e){const s=Number(e.training_readiness_score??78),n=e.training_readiness_level||(s>=80?"Prime":s>=60?"High":s>=40?"Moderate":"Low"),t=s>=80?"text-emerald-400":s>=60?"text-cyan-400":s>=40?"text-amber-400":"text-rose-400",i=s>=80?"bg-emerald-500":s>=60?"bg-cyan-500":s>=40?"bg-amber-500":"bg-rose-500",l=e.vo2max_running!=null?Number(e.vo2max_running).toFixed(1):"--",a=e.vo2max_cycling!=null?Number(e.vo2max_cycling).toFixed(1):"--",o=e.spo2_avg!=null?Number(e.spo2_avg).toFixed(1):"--",d=e.spo2_low!=null?Number(e.spo2_low).toFixed(1):"--",r=e.respiration_waking!=null?Number(e.respiration_waking).toFixed(1):"--",f=e.respiration_sleep!=null?Number(e.respiration_sleep).toFixed(1):"--",u=e.floors_ascended!=null?e.floors_ascended:"--",c=e.floors_descended!=null?e.floors_descended:"--",v=e.hydration_ml!=null?Number(e.hydration_ml):null,m=Number(e.hydration_goal_ml||2500),w=v!=null?(v/1e3).toFixed(2):"--",$=v!=null?Math.min(100,Math.round(v/m*100)):0,z=e.weight_kg!=null?Number(e.weight_kg).toFixed(1):"--",S=e.body_fat_pct!=null?Number(e.body_fat_pct).toFixed(1):"--",M=e.bmi!=null?Number(e.bmi).toFixed(1):"--";return`
    <div id="card-wellness-training-readiness" data-metric="training_readiness" class="lg:col-span-4 bg-[#130d21] border border-[#2d2147] hover:border-cyan-500/40 rounded-xl p-5 flex flex-col justify-between transition-colors cursor-pointer">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Training Readiness</span>
        <span class="text-[10px] font-mono px-2 py-0.5 rounded border border-[#2d2147] bg-[#1b132e] ${t}">${n}</span>
      </div>
      <div class="mt-3 flex items-baseline space-x-2">
        <span class="text-3xl font-bold font-mono tabular-nums ${t}">${s}</span>
        <span class="text-xs text-zinc-500 font-mono">/ 100</span>
      </div>
      <div class="mt-3 w-full h-2 bg-[#1b132e] rounded-full overflow-hidden">
        <div class="h-full ${i} rounded-full" style="width: ${Math.max(0,Math.min(100,s))}%"></div>
      </div>
      <div class="mt-2 text-[11px] text-zinc-500">Click for readiness trend &amp; history</div>
    </div>

    <div class="lg:col-span-8 grid grid-cols-2 sm:grid-cols-3 gap-4">
      <div id="card-wellness-vo2max" data-metric="vo2max" class="bg-[#130d21] border border-[#2d2147] hover:border-violet-500/40 rounded-xl p-4 flex flex-col justify-between transition-colors cursor-pointer">
        <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">VO2 Max</div>
        <div class="mt-2 text-2xl font-bold font-mono text-violet-400 tabular-nums">${l}</div>
        <div class="mt-1 text-[11px] text-zinc-500 font-mono">Run \xB7 Cyc ${a}</div>
      </div>

      <div id="card-wellness-spo2" data-metric="spo2" class="bg-[#130d21] border border-[#2d2147] hover:border-sky-500/40 rounded-xl p-4 flex flex-col justify-between transition-colors cursor-pointer">
        <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Pulse Ox (SpO2)</div>
        <div class="mt-2 text-2xl font-bold font-mono text-sky-400 tabular-nums">${o}%</div>
        <div class="mt-1 text-[11px] text-zinc-500 font-mono">Low ${d}%</div>
      </div>

      <div id="card-wellness-respiration" data-metric="respiration" class="bg-[#130d21] border border-[#2d2147] hover:border-teal-500/40 rounded-xl p-4 flex flex-col justify-between transition-colors cursor-pointer">
        <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Respiration</div>
        <div class="mt-2 text-2xl font-bold font-mono text-teal-400 tabular-nums">${r} <span class="text-xs font-normal text-zinc-500">brpm</span></div>
        <div class="mt-1 text-[11px] text-zinc-500 font-mono">Sleep ${f} brpm</div>
      </div>

      <div id="card-wellness-floors" data-metric="floors" class="bg-[#130d21] border border-[#2d2147] hover:border-amber-500/40 rounded-xl p-4 flex flex-col justify-between transition-colors cursor-pointer">
        <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Floors Climbed</div>
        <div class="mt-2 text-2xl font-bold font-mono text-amber-400 tabular-nums">${u}</div>
        <div class="mt-1 text-[11px] text-zinc-500 font-mono">Descended ${c}</div>
      </div>

      <div id="card-wellness-hydration" data-metric="hydration" class="bg-[#130d21] border border-[#2d2147] hover:border-blue-500/40 rounded-xl p-4 flex flex-col justify-between transition-colors cursor-pointer">
        <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Hydration</div>
        <div class="mt-2 text-2xl font-bold font-mono text-blue-400 tabular-nums">${w} <span class="text-xs font-normal text-zinc-500">L</span></div>
        <div class="mt-1 text-[11px] text-zinc-500 font-mono">${$}% of ${(m/1e3).toFixed(1)}L</div>
      </div>

      <div id="card-wellness-weight" data-metric="weight" class="bg-[#130d21] border border-[#2d2147] hover:border-fuchsia-500/40 rounded-xl p-4 flex flex-col justify-between transition-colors cursor-pointer">
        <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Weight &amp; Body</div>
        <div class="mt-2 text-2xl font-bold font-mono text-fuchsia-400 tabular-nums">${z} <span class="text-xs font-normal text-zinc-500">kg</span></div>
        <div class="mt-1 text-[11px] text-zinc-500 font-mono">BF ${S}% \xB7 BMI ${M}</div>
      </div>
    </div>
  `}function le(){const e=document.getElementById("wellness-dashboard")||document.getElementById("health-fitness-dashboard")||document;!e||!e.querySelectorAll||(e.querySelectorAll("[data-wellness-action]").forEach(s=>{s.onclick=n=>{n.preventDefault(),n.stopPropagation();const t=s.getAttribute("data-wellness-action"),i=s.getAttribute("data-metric");t&&i&&W(i,t)}}),e.querySelectorAll("[data-metric]").forEach(s=>{s.hasAttribute("data-wellness-action")||(s.classList.add("cursor-pointer"),s.onclick=n=>{if(n.target&&n.target.closest&&n.target.closest("[data-wellness-action]"))return;const t=s.getAttribute("data-metric");t&&T(t,b)})}))}function ae(){if(O())return;const e=document.querySelectorAll?document.querySelectorAll('[data-metric][draggable="true"]'):[];let s=null;e.forEach(n=>{n.ondragstart=t=>{s=n.getAttribute("data-metric"),t.dataTransfer&&(t.dataTransfer.setData("text/plain",s),t.dataTransfer.effectAllowed="move"),n.classList.add("opacity-50")},n.ondragend=()=>{n.classList.remove("opacity-50"),s=null},n.ondragover=t=>{t.preventDefault(),t.dataTransfer&&(t.dataTransfer.dropEffect="move")},n.ondrop=t=>{t.preventDefault(),t.stopPropagation();const i=n.getAttribute("data-metric");if(!s||!i||s===i)return;const l=B(),a=l.in_focus.includes(s),o=l.in_focus.includes(i);if(l.in_focus=l.in_focus.filter(d=>d!==s),l.at_a_glance=l.at_a_glance.filter(d=>d!==s),o){const d=l.in_focus.indexOf(i);l.in_focus.splice(d,0,s)}else{const d=l.at_a_glance.indexOf(i);l.at_a_glance.splice(d,0,s)}R(l),b&&I(b)}})}function ce(){b=null}function ue(){const e=document.getElementById("btn-edit-home");e&&e.addEventListener("click",()=>{let s=!1;if(typeof CustomEvent=="function"&&typeof document<"u"&&typeof document.dispatchEvent=="function"){const n=new CustomEvent("garmin-dash:open-customize",{bubbles:!0,cancelable:!0});s=!document.dispatchEvent(n)}if(!s){const n=document.getElementById("customize-modal");n&&n.classList.remove("hidden")}})}export{N as DEFAULT_WELLNESS_LAYOUT,G as WELLNESS_METRIC_METADATA,de as addWellnessCard,C as canonicalizeMetricKey,ce as clearWellnessCache,A as formatCalories,h as formatSleepDuration,E as formatSteps,y as getStatusBadgeColor,O as isTouchDevice,B as loadWellnessLayout,W as moveWellnessCard,T as openMetricTrendModal,I as renderWellnessDashboard,re as resetWellnessLayout,R as saveWellnessLayout,ue as setupWellnessEventListeners};
