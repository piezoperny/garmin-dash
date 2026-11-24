import{openActivityDrawer as P,escapeHtml as k}from"./activities.js";import{normalizeSportCategory as _,extractDateStr as $}from"./calendar.js";function C(e){return!e||typeof e!="object"?0:e.distance_meters!=null&&e.distance_meters!==""&&Number.isFinite(Number(e.distance_meters))?Number(e.distance_meters):e.distance_m!=null&&e.distance_m!==""&&Number.isFinite(Number(e.distance_m))?Number(e.distance_m):e.distance_km!=null&&e.distance_km!==""&&Number.isFinite(Number(e.distance_km))?Number(e.distance_km)*1e3:e.distance!=null&&e.distance!==""&&Number.isFinite(Number(e.distance))?Number(e.distance):0}function F(e){if(!e||typeof e!="object")return 0;const t=e.elevation_gain_meters??e.elevation_gain_m??e.elevation_m??e.elevation_gain??0;return Number.isFinite(Number(t))?Number(t):0}function H(e){if(!e||typeof e!="object")return 0;const t=e.avg_power??e.average_power??e.power??0;return Number.isFinite(Number(t))?Number(t):0}function E(e){if(!e||typeof e!="object")return 0;const t=e.tss??e.training_stress_score??0;return Number.isFinite(Number(t))?Number(t):0}function R(e){if(!e||typeof e!="object")return 0;const t=e.duration_seconds??e.duration_s??e.duration_sec??e.duration??0;return Number.isFinite(Number(t))?Number(t):0}function j(e,t="km"){return!e||e<=0?"--":t==="mi"||t==="imperial"?`${(e/1609.344).toFixed(1)} mi`:`${(e/1e3).toFixed(1)} km`}function G(e,t="km"){return!e||e<=0?"--":t==="mi"||t==="imperial"?`+${Math.round(e*3.28084).toLocaleString()} ft`:`+${Math.round(e).toLocaleString()} m`}function I(e){if(!e||e<=0)return"--";const t=Math.round(e/60),c=Math.floor(t/60),a=t%60;return c>0?`${c}h ${a}m`:`${a}m`}function U(e){switch(e){case"cycling":return"\u{1F6B4}";case"running":return"\u{1F3C3}";case"hiking":return"\u{1F97E}";case"strength":return"\u{1F3CB}\uFE0F";case"swimming":return"\u{1F3CA}";default:return"\u26A1"}}function B(e=[],t=null){const c=Array.isArray(e)?e:[],a=t?c.filter(u=>{const y=$(u);return y&&y.startsWith(String(t))}):c,m=(u,y)=>{let w=null,h=0;for(const n of u){const x=y(n);x>h&&(h=x,w=n)}return{activity:w,value:h}},l=a.filter(u=>_(u).toLowerCase()==="cycling"),g=a.filter(u=>{const y=_(u).toLowerCase();return y==="hiking"||y==="running"}),i=m(l,C),r=m(g,C),s=m(a,F),d=m(l.length?l:a,H),f=m(a,E),v=m(a,R);return[{id:"longest_ride",label:"Longest Ride (Cycling)",sport:"cycling",activity:i.activity,value:i.value,format:u=>j(i.value,u)},{id:"longest_hike_run",label:"Longest Hike / Run",sport:r.activity?_(r.activity):"running",activity:r.activity,value:r.value,format:u=>j(r.value,u)},{id:"biggest_climb",label:"Biggest Elevation Climb",sport:s.activity?_(s.activity):"hiking",activity:s.activity,value:s.value,format:u=>G(s.value,u)},{id:"peak_power",label:"Peak Cycling Power",sport:"cycling",activity:d.activity,value:d.value,format:()=>d.value>0?`${Math.round(d.value)} W`:"--"},{id:"highest_tss",label:"Highest Training Load",sport:f.activity?_(f.activity):"cycling",activity:f.activity,value:f.value,format:()=>f.value>0?`${Math.round(f.value)} TSS`:"--"},{id:"longest_duration",label:"Longest Workout Duration",sport:v.activity?_(v.activity):"all",activity:v.activity,value:v.value,format:()=>I(v.value)}]}let A="all";function q(e,t="km"){const c=document.getElementById("pr-trophy-case");if(!c)return;const a=Array.isArray(e?.activities)?e.activities:[],m=a.map(i=>$(i)).filter(Boolean).map(i=>Number(i.slice(0,4))).filter(i=>Number.isFinite(i)),l=m.length?Math.max(...m):new Date().getFullYear(),g=B(a,A==="year"?l:null);c.innerHTML=`
    <div class="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#2d2147]">
      <div class="flex items-center space-x-2">
        <span class="text-amber-400 text-sm">\u{1F3C6}</span>
        <h3 class="text-sm font-semibold text-white tracking-tight">Personal Records &amp; Trophy Case</h3>
        <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold border text-amber-300 border-amber-500/35 bg-amber-500/15">
          ${A==="year"?`${l} SEASON`:"ALL-TIME"}
        </span>
      </div>
      <div class="flex items-center space-x-1 bg-[#0b0714] p-0.5 rounded-lg border border-[#2d2147]">
        <button type="button" data-pr-scope="all" class="px-2.5 py-1 rounded-md text-[11px] font-semibold transition ${A==="all"?"bg-purple-600 text-white":"text-zinc-400 hover:text-white"}">
          All-Time
        </button>
        <button type="button" data-pr-scope="year" class="px-2.5 py-1 rounded-md text-[11px] font-semibold transition ${A==="year"?"bg-purple-600 text-white":"text-zinc-400 hover:text-white"}">
          ${l}
        </button>
      </div>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-2">
      ${g.map(i=>{const r=i.activity,s=r&&$(r)||"--",d=r?k(r.activity_name||r.name||r.title||"Workout"):"No record yet",f=i.format(t),v=!!r;return`
          <button
            type="button"
            data-pr-id="${i.id}"
            ${v?"":"disabled"}
            class="text-left group bg-[#1b132e]/70 hover:bg-[#23183b] border border-[#2d2147] hover:border-amber-500/40 rounded-xl p-3 transition flex flex-col justify-between space-y-2 ${v?"cursor-pointer":"opacity-60 cursor-default"}"
          >
            <div class="flex items-center justify-between w-full">
              <span class="inline-flex items-center space-x-1.5 text-[11px] font-semibold text-zinc-300">
                <span>${U(i.sport)}</span>
                <span>${k(i.label)}</span>
              </span>
              <span class="px-1.5 py-0.5 rounded-full text-[9px] font-mono font-bold bg-gradient-to-r from-amber-500/20 to-purple-500/20 text-amber-300 border border-amber-500/30">
                PR
              </span>
            </div>
            <div class="text-xl font-bold font-mono text-white group-hover:text-amber-300 transition">
              ${k(f)}
            </div>
            <div class="flex items-center justify-between text-[11px] text-zinc-400 w-full">
              <span class="truncate max-w-[65%]">${d}</span>
              <span class="font-mono text-[10px] text-zinc-500">${k(s)}</span>
            </div>
          </button>
        `}).join("")}
    </div>
  `,c.querySelectorAll("[data-pr-scope]").forEach(i=>{i.addEventListener("click",()=>{A=i.getAttribute("data-pr-scope")||"all",q(e,t)})}),c.querySelectorAll("[data-pr-id]").forEach(i=>{i.addEventListener("click",()=>{const r=i.getAttribute("data-pr-id"),s=g.find(d=>d.id===r);s&&s.activity&&P(s.activity,t)})})}function O(e,t="tss",c=null){const a=Array.isArray(e?.activities)?e.activities:[],m=Array.isArray(e?.wellness?.daily)?e.wellness.daily:Array.isArray(e?.daily_wellness)?e.daily_wellness:Array.isArray(e?.wellness_daily)?e.wellness_daily:[],l=new Map;for(const n of a){const x=$(n);if(!x)continue;const o=l.get(x)||{tss:0,durationSec:0,count:0,steps:0,stepsGoal:1e4,sleepScore:0};o.tss+=E(n),o.durationSec+=R(n),o.count+=1,l.set(x,o)}for(const n of m){const x=$(n);if(!x)continue;const o=l.get(x)||{tss:0,durationSec:0,count:0,steps:0,stepsGoal:1e4,sleepScore:0};n.steps!=null&&(o.steps=Math.max(o.steps,Number(n.steps)||0)),n.steps_goal!=null&&Number(n.steps_goal)>0&&(o.stepsGoal=Number(n.steps_goal)),n.sleep_score!=null?o.sleepScore=Math.max(o.sleepScore,Number(n.sleep_score)||0):n.sleep_hours!=null?o.sleepScore=Math.max(o.sleepScore,Math.round((Number(n.sleep_hours)||0)*12)):n.sleep_seconds!=null&&(o.sleepScore=Math.max(o.sleepScore,Math.min(100,Math.round(Number(n.sleep_seconds)/28800*85)))),o.tss===0&&n.training_load!=null&&(o.tss=Number(n.training_load)||0),l.set(x,o)}let g;if(c)g=new Date(`${c}T00:00:00Z`),Number.isNaN(g.getTime())&&(g=new Date);else{const n=Array.from(l.keys()).sort();g=n.length?new Date(`${n[n.length-1]}T00:00:00Z`):new Date}const i=new Date(g);i.setUTCDate(i.getUTCDate()-364);const r=(i.getUTCDay()+6)%7,s=new Date(i);s.setUTCDate(s.getUTCDate()-r);const d=[];let f=0,v=0,u=0,y=0,w=0,h=0;for(let n=0;n<53;n++){const x=[];for(let o=0;o<7;o++){const N=new Date(s);N.setUTCDate(s.getUTCDate()+n*7+o);const L=N.toISOString().slice(0,10),T=N>=i&&N<=g,p=l.get(L)||{tss:0,durationSec:0,count:0,steps:0,stepsGoal:1e4,sleepScore:0};let b=0,D=0;if(T)if(p.count>0?(f+=1,v+=p.durationSec,y+=1):y=0,u=y,p.steps>=p.stepsGoal&&p.steps>0?(h+=1,h>w&&(w=h)):h=0,t==="tss")b=p.tss,D=b<=0?0:b<40?1:b<80?2:b<130?3:4;else if(t==="steps"){b=p.steps;const M=p.stepsGoal>0?b/p.stepsGoal:0;D=b<=0?0:M<.5?1:M<.85?2:M<1?3:4}else b=p.sleepScore,D=b<=0?0:b<55?1:b<70?2:b<85?3:4;x.push({dateStr:L,inRange:T,value:b,level:D,count:p.count,tss:p.tss,steps:p.steps,sleepScore:p.sleepScore})}d.push(x)}return{mode:t,weeks:d,badges:{currentActiveStreak:u,longestStepStreak:w,activeDays365:f,totalAnnualHours:Math.round(v/3600*10)/10}}}let S="tss";const z={0:"bg-[#161026] border-[#261c3d]",1:"bg-purple-900/60 border-purple-700/40",2:"bg-purple-700/75 border-purple-500/50",3:"bg-purple-500/85 border-purple-400/60",4:"bg-emerald-400 border-emerald-300/80"};function W(e,t=null,c={}){const a=t||document.getElementById("consistency-heatmap-card");if(!a)return;const m=O(e,S),{badges:l,weeks:g}=m;a.innerHTML=`
    <div class="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#2d2147]">
      <div class="flex items-center space-x-2">
        <h3 class="text-sm font-semibold text-white tracking-tight">365-Day Consistency Heatmap</h3>
        <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold border text-emerald-300 border-emerald-500/35 bg-emerald-500/15">
          YEAR IN PIXELS
        </span>
      </div>
      <div class="flex items-center space-x-1 bg-[#0b0714] p-0.5 rounded-lg border border-[#2d2147]">
        <button type="button" data-heatmap-mode="tss" class="px-2 py-1 rounded-md text-[11px] font-semibold transition ${S==="tss"?"bg-purple-600 text-white":"text-zinc-400 hover:text-white"}">
          Training Load (TSS)
        </button>
        <button type="button" data-heatmap-mode="steps" class="px-2 py-1 rounded-md text-[11px] font-semibold transition ${S==="steps"?"bg-purple-600 text-white":"text-zinc-400 hover:text-white"}">
          Daily Steps Goal
        </button>
        <button type="button" data-heatmap-mode="sleep" class="px-2 py-1 rounded-md text-[11px] font-semibold transition ${S==="sleep"?"bg-purple-600 text-white":"text-zinc-400 hover:text-white"}">
          Sleep &amp; Recovery
        </button>
      </div>
    </div>

    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2">
      <div class="bg-[#1b132e]/60 border border-[#2d2147] rounded-lg px-3 py-2">
        <div class="text-[10px] text-zinc-400 uppercase tracking-wider">Current Active Streak</div>
        <div class="text-base font-bold font-mono text-white">${l.currentActiveStreak}d</div>
      </div>
      <div class="bg-[#1b132e]/60 border border-[#2d2147] rounded-lg px-3 py-2">
        <div class="text-[10px] text-zinc-400 uppercase tracking-wider">Longest Step Goal Streak</div>
        <div class="text-base font-bold font-mono text-emerald-400">${l.longestStepStreak}d</div>
      </div>
      <div class="bg-[#1b132e]/60 border border-[#2d2147] rounded-lg px-3 py-2">
        <div class="text-[10px] text-zinc-400 uppercase tracking-wider">Active Days (Last 365d)</div>
        <div class="text-base font-bold font-mono text-purple-300">${l.activeDays365}</div>
      </div>
      <div class="bg-[#1b132e]/60 border border-[#2d2147] rounded-lg px-3 py-2">
        <div class="text-[10px] text-zinc-400 uppercase tracking-wider">Total Annual Hours</div>
        <div class="text-base font-bold font-mono text-amber-300">${l.totalAnnualHours}h</div>
      </div>
    </div>

    <div class="overflow-x-auto pt-2">
      <div data-heatmap-grid="true" class="inline-grid grid-flow-col gap-1" style="grid-template-rows: repeat(7, minmax(0, 1fr));">
        ${g.map(r=>r.map(s=>{const d=s.inRange?z[s.level]||z[0]:"opacity-0 pointer-events-none",f=S==="tss"?`${Math.round(s.tss)} TSS`:S==="steps"?`${s.steps.toLocaleString()} steps`:`Sleep ${s.sleepScore}`,v=`${s.dateStr}: ${f} (${s.count} workouts)`;return`<button type="button" data-heatmap-date="${s.dateStr}" title="${k(v)}" class="w-2.5 h-2.5 rounded-[2px] border ${d} hover:ring-1 hover:ring-white transition"></button>`}).join("")).join("")}
      </div>
    </div>
  `,a.querySelectorAll("[data-heatmap-mode]").forEach(r=>{r.addEventListener("click",()=>{S=r.getAttribute("data-heatmap-mode")||"tss",W(e,a,c)})}),(a.querySelector('[data-heatmap-grid="true"]')||a).addEventListener("click",r=>{let s=null;if(r&&r.target&&(typeof r.target.closest=="function"?s=r.target.closest("[data-heatmap-date]"):typeof r.target.getAttribute=="function"&&r.target.getAttribute("data-heatmap-date")&&(s=r.target)),!s)return;const d=s.getAttribute("data-heatmap-date");d&&typeof c.onSelectDate=="function"&&c.onSelectDate(d)})}export{O as computeConsistencyData,B as computePersonalRecords,W as renderConsistencyHeatmap,q as renderPRTrophyCase};
