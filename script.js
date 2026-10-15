
  (() => {
    'use strict';
    // ============================================================
    // KONFIGURASI DEMO
    // Untuk integrasi nyata, gantikan updateLiveReadings() dengan
    // data JSON yang diterima dari ESP32 / endpoint web server Anda.
    // Struktur per channel yang digunakan: { voltage, current, pf }.
    // ============================================================
    const UPDATE_INTERVAL_MS = 2500;
    const UNDER_VOLTAGE_THRESHOLD = 205;
    const MAX_LIVE_POINTS = 24;
    const STORAGE_KEY = 'powersight_maintenance_v1';
    const COLORS = ['#3578f6', '#15b9d6', '#8667f5', '#fa9a3b'];
    const MACHINE_NAMES = ['Mesin Produksi A', 'Mesin CNC B', 'Mesin CNC C', 'Mesin Conveyor D'];
    const MACHINE_IDS = ['CH-01', 'CH-02', 'CH-03', 'CH-04'];
    const MACHINE_ICONS = [
      '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="7" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M7 7V4h10v3M7 12h3m4 0h3M8 16h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
      '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.7"/><path d="M12 3.5v6m8.5 2.5h-6M12 20.5v-6m-8.5-2.5h6" stroke="currentColor" stroke-width="1.7"/></svg>',
      '<svg viewBox="0 0 24 24" fill="none"><path d="M4 17V9l8-5 8 5v8l-8 4-8-4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M4 9l8 5 8-5M12 14v7" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
      '<svg viewBox="0 0 24 24" fill="none"><path d="M3 8h18v9H3zM6 8V5m6 3V5m6 3V5M5 17v2m14-2v2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="7" cy="12.5" r="1" fill="currentColor"/><circle cx="12" cy="12.5" r="1" fill="currentColor"/><circle cx="17" cy="12.5" r="1" fill="currentColor"/></svg>'
    ];

    const state = {
      clockOffsetMs: 0,
      timeSynced: false,
      readings: MACHINE_NAMES.map((_, i) => ({ voltage: 219 + Math.random() * 4, current: 8 + i * 5 + Math.random() * 4, pf: .82 + Math.random() * .16, power: 0 })),
      liveLabels: [], avgVoltageLive: [], avgCurrentLive: [],
      liveDropTotal: 0,
      currentHourDropCount: [0,0,0,0],
      hourlyDrop: Array.from({length:24}, () => [0,0,0,0]),
      dailyDrop: [], hourlyEnergy: [], dailyEnergy: [], monthlyEnergyByMachine: [], dailyCombined: [], monthlyCombined: [],
      charts: {}, maintenance: []
    };

    const $ = (id) => document.getElementById(id);
    const fmt = (value, digits = 1) => Number(value).toLocaleString('id-ID', {minimumFractionDigits: digits, maximumFractionDigits: digits});
    const fmtInt = (value) => Math.round(value).toLocaleString('id-ID');
    const pad = n => String(n).padStart(2, '0');
    const nowCorrected = () => new Date(Date.now() + state.clockOffsetMs);
    const nowPartsJakarta = (date = nowCorrected()) => {
      const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Jakarta', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'}).formatToParts(date);
      const out = {}; parts.forEach(p => { if (p.type !== 'literal') out[p.type] = p.value; }); return out;
    };
    const jakartaDateKey = (date = nowCorrected()) => { const p = nowPartsJakarta(date); return `${p.year}-${p.month}-${p.day}`; };
    const jakartaHour = (date = nowCorrected()) => Number(nowPartsJakarta(date).hour);
    const dateAtJakartaOffset = (daysAgo = 0) => new Date(nowCorrected().getTime() - daysAgo * 86400000);
    const formatJakartaDate = (date, withTime = true) => new Intl.DateTimeFormat('id-ID', {
      timeZone:'Asia/Jakarta', day:'2-digit', month:'short', year:'numeric', ...(withTime ? {hour:'2-digit', minute:'2-digit', hourCycle:'h23'} : {})
    }).format(date);
    const formatJakartaShort = (date) => new Intl.DateTimeFormat('id-ID', {timeZone:'Asia/Jakarta',day:'2-digit',month:'short'}).format(date);
    const localDatetimeValue = (date = nowCorrected()) => {
      // Isi datetime-local memakai komponen WIB agar nilainya konsisten dengan clock dashboard.
      const p = nowPartsJakarta(date);
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    };
    const parseWibInput = (value) => {
      // datetime-local diperlakukan sebagai waktu Asia/Jakarta (UTC+7).
      const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
      if (!match) return new Date(value);
      const [,y,mo,d,h,mi] = match.map((v, i) => i === 0 ? v : Number(v));
      return new Date(Date.UTC(y, mo - 1, d, h - 7, mi));
    };
    const monthLabels = (count = 12) => {
      const base = nowCorrected();
      return Array.from({length:count}, (_, i) => {
        const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - (count - 1 - i), 1, 5));
        return new Intl.DateTimeFormat('id-ID', {timeZone:'Asia/Jakarta',month:'short',year:'2-digit'}).format(d);
      });
    };

    function renderMachineCards() {
      $('machineGrid').innerHTML = MACHINE_NAMES.map((name, i) => `
        <article class="machine-card" id="machineCard${i}" style="--machine-color:${COLORS[i]}">
          <div class="machine-head"><div class="machine-title-wrap"><div class="machine-icon">${MACHINE_ICONS[i]}</div><div style="min-width:0"><div class="machine-name">${name}</div><div class="machine-sub">PZEM-004 · ${MACHINE_IDS[i]}</div></div></div><div class="online-tag"><span class="dot"></span>LIVE</div></div>
          <div class="metric-main"><div><div class="label">Voltage</div><div class="value" id="voltage${i}">—<span class="unit">V</span></div></div><div class="metric-badge" id="voltageState${i}">NORMAL</div></div>
          <div class="mini-meter"><span id="voltageMeter${i}" style="width:55%"></span></div>
          <div class="machine-metrics">
            <div class="small-metric"><div class="sm-label">Current</div><div class="sm-value" id="current${i}">—<span class="sm-unit">A</span></div></div>
            <div class="small-metric"><div class="sm-label">Power factor</div><div class="sm-value" id="pf${i}">—</div></div>
            <div class="small-metric"><div class="sm-label">Active power</div><div class="sm-value" id="power${i}">—<span class="sm-unit">W</span></div></div>
          </div>
          <div class="alarm-line">⚠ Voltage drop terdeteksi (&lt; 205 V)</div>
        </article>`).join('');
    }

    function chartBaseOptions(extra = {}) {
      return {
        responsive:true, maintainAspectRatio:false, animation:{duration:380}, interaction:{mode:'index', intersect:false},
        plugins:{ legend:{labels:{usePointStyle:true, pointStyle:'circle', boxWidth:7, boxHeight:7, color:'#6d7d96', font:{family:'Manrope', size:10, weight:'600'}, padding:14}}, tooltip:{backgroundColor:'#132844', titleFont:{family:'Manrope',weight:'700'},bodyFont:{family:'DM Mono'},padding:11,cornerRadius:10,displayColors:true} },
        scales:{
          x:{grid:{display:false},ticks:{color:'#8290a5',font:{family:'Manrope',size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},border:{display:false}},
          y:{beginAtZero:true,grid:{color:'rgba(219,228,240,.65)'},ticks:{color:'#8290a5',font:{family:'DM Mono',size:9}},border:{display:false}}
        }, ...extra
      };
    }
    function lineDataset(label, color, data, extra = {}) {
      return {label, data, borderColor:color, backgroundColor:color, borderWidth:2, pointRadius:0, pointHoverRadius:4, tension:.32, fill:false, ...extra};
    }
    function createChart(id, config) {
      if (state.charts[id]) state.charts[id].destroy();
      const ctx = $(id).getContext('2d');
      state.charts[id] = new Chart(ctx, config);
      return state.charts[id];
    }

    function seedHistory() {
      // Simulasi histori yang masuk akal agar grafik sudah terlihat pada pertama kali dibuka.
      const today = nowCorrected();
      const dayLabels = Array.from({length:30}, (_, i) => formatJakartaShort(dateAtJakartaOffset(29-i)));
      state.dailyDrop = dayLabels.map(() => MACHINE_NAMES.map(() => Math.random() < .7 ? 0 : Math.floor(Math.random()*4)+1));
      state.hourlyDrop = Array.from({length:24}, () => MACHINE_NAMES.map(() => Math.random() < .88 ? 0 : Math.floor(Math.random()*2)+1));
      const hours = Array.from({length:24}, (_, i) => `${pad(i)}:00`);
      state.hourlyEnergy = MACHINE_NAMES.map((_, ch) => hours.map((_, h) => {
        const running = (h >= 6 && h <= 21) ? 1 : .24;
        return +( (.65 + ch * .35 + Math.random() * 1.8) * running ).toFixed(2);
      }));
      state.dailyEnergy = MACHINE_NAMES.map((_, ch) => dayLabels.map(() => +(10 + ch * 6 + Math.random()*28).toFixed(1)));
      state.monthlyEnergyByMachine = MACHINE_NAMES.map((_, ch) => monthLabels(12).map(() => +(450 + ch*180 + Math.random()*360).toFixed(0)));
      state.dailyCombined = dayLabels.map((_, i) => +(state.dailyEnergy.reduce((sum, series) => sum + series[i], 0)).toFixed(1));
      state.monthlyCombined = monthLabels(12).map((_, i) => +(state.monthlyEnergyByMachine.reduce((sum, series) => sum + series[i], 0)).toFixed(0));
      state.historyLabels = dayLabels;
      state.hourLabels = hours;
      state.monthLabels = monthLabels(12);
      // Bawa 24 titik terakhir ke chart realtime.
      for (let i = MAX_LIVE_POINTS - 1; i >= 0; i--) {
        const d = new Date(today.getTime() - i * UPDATE_INTERVAL_MS);
        state.liveLabels.push(new Intl.DateTimeFormat('id-ID', {timeZone:'Asia/Jakarta', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'}).format(d));
        state.avgVoltageLive.push(219 + Math.random()*3.5);
        state.avgCurrentLive.push(19 + Math.random()*4);
      }
    }

    function initCharts() {
      createChart('avgLiveChart', {
        type:'line', data:{labels:state.liveLabels, datasets:[
          lineDataset('Average Voltage (V)', '#3578f6', state.avgVoltageLive, {yAxisID:'yV', borderWidth:2.6, pointRadius:0, fill:true, backgroundColor:ctx => {
            const chart = ctx.chart; const area = chart.chartArea; if (!area) return 'rgba(53,120,246,.08)';
            const gradient = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom); gradient.addColorStop(0,'rgba(53,120,246,.20)'); gradient.addColorStop(1,'rgba(53,120,246,0)'); return gradient;
          }}),
          lineDataset('Average Current (A)', '#15b9d6', state.avgCurrentLive, {yAxisID:'yA', borderWidth:2.4, pointRadius:0})
        ]}, options:chartBaseOptions({scales:{
          x:{grid:{display:false},ticks:{color:'#8290a5',font:{family:'DM Mono',size:9},maxTicksLimit:8,maxRotation:0},border:{display:false}},
          yV:{type:'linear',position:'left',min:195,max:235,grid:{color:'rgba(219,228,240,.65)'},ticks:{color:'#3578f6',font:{family:'DM Mono',size:10},callback:v=>v+' V'},title:{display:true,text:'Voltage (V)',color:'#3578f6',font:{family:'Manrope',size:10,weight:'700'}},border:{display:false}},
          yA:{type:'linear',position:'right',beginAtZero:true,suggestedMax:40,grid:{drawOnChartArea:false},ticks:{color:'#15a9c8',font:{family:'DM Mono',size:10},callback:v=>v+' A'},title:{display:true,text:'Current (A)',color:'#15a9c8',font:{family:'Manrope',size:10,weight:'700'}},border:{display:false}}
        }})
      });

      createChart('hourlyDropChart', {type:'line', data:{labels:state.hourLabels,datasets:MACHINE_NAMES.map((n,i)=>lineDataset(`CH-${i+1}`,COLORS[i],state.hourlyDrop.map(row=>row[i]),{borderWidth:2,pointRadius:2,pointHoverRadius:5}))},options:chartBaseOptions({scales:{x:{grid:{display:false},ticks:{autoSkip:true,maxTicksLimit:8,color:'#8290a5',font:{size:9}},border:{display:false}},y:{beginAtZero:true,grid:{color:'rgba(219,228,240,.65)'},ticks:{precision:0,color:'#8290a5',font:{size:9}},border:{display:false},title:{display:true,text:'Deteksi (kali)',font:{size:9,weight:'700'},color:'#8290a5'}}}})});
      createChart('dailyDropChart', {type:'line', data:{labels:state.historyLabels,datasets:MACHINE_NAMES.map((n,i)=>lineDataset(`CH-${i+1}`,COLORS[i],state.dailyDrop.map(row=>row[i]),{borderWidth:2,pointRadius:1.5,pointHoverRadius:4}))},options:chartBaseOptions({scales:{x:{grid:{display:false},ticks:{autoSkip:true,maxTicksLimit:10,color:'#8290a5',font:{size:9}},border:{display:false}},y:{beginAtZero:true,grid:{color:'rgba(219,228,240,.65)'},ticks:{precision:0,color:'#8290a5',font:{size:9}},border:{display:false},title:{display:true,text:'Deteksi (kali)',font:{size:9,weight:'700'},color:'#8290a5'}}}})});
      createChart('hourlyEnergyChart', {type:'line',data:{labels:state.hourLabels,datasets:MACHINE_NAMES.map((n,i)=>lineDataset(`CH-${i+1}`,COLORS[i],state.hourlyEnergy[i],{borderWidth:2,pointRadius:0,pointHoverRadius:4}))},options:chartBaseOptions({scales:{x:{grid:{display:false},ticks:{autoSkip:true,maxTicksLimit:8,color:'#8290a5',font:{size:9}},border:{display:false}},y:{beginAtZero:true,grid:{color:'rgba(219,228,240,.65)'},ticks:{color:'#8290a5',font:{family:'DM Mono',size:9},callback:v=>v+' kWh'},border:{display:false}}}})});
      createChart('dailyEnergyChart', {type:'line',data:{labels:state.historyLabels,datasets:MACHINE_NAMES.map((n,i)=>lineDataset(`CH-${i+1}`,COLORS[i],state.dailyEnergy[i],{borderWidth:2,pointRadius:0,pointHoverRadius:4}))},options:chartBaseOptions({scales:{x:{grid:{display:false},ticks:{autoSkip:true,maxTicksLimit:10,color:'#8290a5',font:{size:9}},border:{display:false}},y:{beginAtZero:true,grid:{color:'rgba(219,228,240,.65)'},ticks:{color:'#8290a5',font:{family:'DM Mono',size:9},callback:v=>v+' kWh'},border:{display:false}}}})});
      createChart('machineMonthlyBarChart', {
        type:'bar', data:{labels:state.historyLabels, datasets:MACHINE_NAMES.map((n,i)=>({label:`CH-${i+1}`,data:state.dailyEnergy[i],backgroundColor:COLORS[i]+'c9',borderColor:COLORS[i],borderWidth:1,borderRadius:3,borderSkipped:false,maxBarThickness:13}))},
        options:chartBaseOptions({scales:{
          x:{grid:{display:false},ticks:{autoSkip:true,maxTicksLimit:12,color:'#8290a5',font:{size:9}},border:{display:false},stacked:false},
          y:{beginAtZero:true,grid:{color:'rgba(219,228,240,.65)'},ticks:{color:'#8290a5',font:{family:'DM Mono',size:9},callback:v=>v+' kWh'},border:{display:false}}
        }})
      });
      createChart('totalDailyBarChart', {type:'bar',data:{labels:state.historyLabels,datasets:[{label:'Total 4 mesin',data:state.dailyCombined,backgroundColor:state.historyLabels.map((_,i)=>i===29?'#15b9d6':'rgba(53,120,246,.72)'),borderRadius:5,borderSkipped:false,maxBarThickness:25}]},options:chartBaseOptions({plugins:{legend:{display:false},tooltip:{backgroundColor:'#132844',padding:11,cornerRadius:10,callbacks:{label:c=>` Total: ${fmt(c.raw,1)} kWh`}}},scales:{x:{grid:{display:false},ticks:{autoSkip:true,maxTicksLimit:12,color:'#8290a5',font:{size:9}},border:{display:false}},y:{beginAtZero:true,grid:{color:'rgba(219,228,240,.65)'},ticks:{color:'#8290a5',font:{family:'DM Mono',size:9},callback:v=>v+' kWh'},border:{display:false}}}})});
      createChart('totalMonthlyBarChart', {type:'bar',data:{labels:state.monthLabels,datasets:[{label:'Total 4 mesin',data:state.monthlyCombined,backgroundColor:'rgba(134,103,245,.76)',borderColor:'#8667f5',borderWidth:1,borderRadius:7,borderSkipped:false,maxBarThickness:48}]},options:chartBaseOptions({plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{color:'#8290a5',font:{size:10}},border:{display:false}},y:{beginAtZero:true,grid:{color:'rgba(219,228,240,.65)'},ticks:{color:'#8290a5',font:{family:'DM Mono',size:10},callback:v=>v+' kWh'},border:{display:false}}}})});
      createChart('maintenanceChart', {type:'bar',data:{labels:state.monthLabels,datasets:[{label:'Maintenance',data:Array(12).fill(0),backgroundColor:'rgba(134,103,245,.73)',borderRadius:5,borderSkipped:false,maxBarThickness:32}]},options:chartBaseOptions({plugins:{legend:{display:false},tooltip:{backgroundColor:'#132844',padding:11,cornerRadius:10,callbacks:{label:c=>` ${c.raw} catatan`}}},scales:{x:{grid:{display:false},ticks:{color:'#8290a5',font:{size:9}},border:{display:false}},y:{beginAtZero:true,grid:{color:'rgba(219,228,240,.65)'},ticks:{precision:0,color:'#8290a5',font:{family:'DM Mono',size:9}},border:{display:false}}}})});
    }

    function updateClock() {
      const now = nowCorrected();
      const p = nowPartsJakarta(now);
      $('liveClock').textContent = `${p.hour}:${p.minute}:${p.second} WIB`;
      $('liveDate').textContent = new Intl.DateTimeFormat('id-ID',{timeZone:'Asia/Jakarta',weekday:'long',day:'2-digit',month:'long',year:'numeric'}).format(now);
      $('timeSyncNote').textContent = state.timeSynced ? 'Waktu: tersinkronisasi internet · WIB' : 'Waktu: jam perangkat · WIB (fallback)';
    }
    async function syncInternetTime() {
      const endpoints = [
        'https://worldtimeapi.org/api/timezone/Asia/Jakarta',
        'https://timeapi.io/api/Time/current/zone?timeZone=Asia/Jakarta'
      ];
      for (const url of endpoints) {
        try {
          const response = await fetch(url, {cache:'no-store', mode:'cors'});
          if (!response.ok) throw new Error('Time API HTTP '+response.status);
          const data = await response.json();
          const raw = data.datetime || data.dateTime;
          if (!raw) throw new Error('Format waktu tidak dikenali');
          const serverMs = new Date(raw).getTime();
          if (!Number.isFinite(serverMs)) throw new Error('Waktu server tidak valid');
          state.clockOffsetMs = serverMs - Date.now();
          state.timeSynced = true;
          $('connectionStatus').textContent = 'SIMULATION ACTIVE · CLOCK SYNC';
          updateClock();
          return;
        } catch (error) { /* Coba penyedia waktu berikutnya. */ }
      }
      state.timeSynced = false;
      $('connectionStatus').textContent = 'SIMULATION ACTIVE';
      updateClock();
    }

    function randomReading(index) {
      // Biasanya sekitar 220 V. Drop sesekali disisipkan agar grafik alarm dapat diuji.
      const hasDip = Math.random() < 0.004;
      const voltage = hasDip ? 196 + Math.random()*8.5 : 217.5 + Math.random()*6.5;
      const current = 5 + Math.random()*35;
      const pf = .7 + Math.random()*.3;
      return {voltage, current, pf, power:voltage*current*pf};
    }
    function updateLiveReadings() {
      const now = nowCorrected();
      const timeLabel = new Intl.DateTimeFormat('id-ID',{timeZone:'Asia/Jakarta',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(now);
      const previousHour = state.lastHour;
      const hour = jakartaHour(now);
      if (previousHour !== undefined && previousHour !== hour) state.currentHourDropCount = [0,0,0,0];
      state.lastHour = hour;
      let voltageSum = 0, currentSum = 0, powerSum = 0, alertCount = 0;
      state.readings = state.readings.map((_, i) => {
        const r = randomReading(i);
        voltageSum += r.voltage; currentSum += r.current; powerSum += r.power;
        const card = $('machineCard'+i);
        $('voltage'+i).innerHTML = `${fmt(r.voltage,1)}<span class="unit">V</span>`;
        $('current'+i).innerHTML = `${fmt(r.current,1)}<span class="sm-unit">A</span>`;
        $('pf'+i).textContent = fmt(r.pf,2);
        $('power'+i).innerHTML = `${fmtInt(r.power)}<span class="sm-unit">W</span>`;
        $('voltageMeter'+i).style.width = `${Math.max(5,Math.min(100,(r.voltage-180)/55*100))}%`;
        const alert = r.voltage < UNDER_VOLTAGE_THRESHOLD;
        card.classList.toggle('is-alert', alert);
        $('voltageState'+i).textContent = alert ? 'VOLTAGE DROP' : 'NORMAL';
        $('voltageState'+i).style.color = alert ? '#c23d4b' : '#16865f';
        $('voltageState'+i).style.background = alert ? '#fff0f1' : '#e8fbf3';
        if (alert) {
          alertCount++;
          state.currentHourDropCount[i]++;
          state.liveDropTotal++;
          const dailyIndex = state.dailyDrop.length - 1;
          if (dailyIndex >= 0) state.dailyDrop[dailyIndex][i]++;
          if (state.hourlyDrop[hour]) state.hourlyDrop[hour][i]++;
        }
        return r;
      });
      const avgV = voltageSum / state.readings.length;
      const avgA = currentSum / state.readings.length;
      $('totalPower').innerHTML = `${fmtInt(powerSum)} <small style="font-size:11px;color:#72819a">W</small>`;
      $('averageVoltage').innerHTML = `${fmt(avgV,1)} <small style="font-size:11px;color:#72819a">V</small>`;
      $('totalCurrent').innerHTML = `${fmt(currentSum,1)} <small style="font-size:11px;color:#72819a">A</small>`;
      $('totalDrops').textContent = fmtInt(state.liveDropTotal);
      $('lastUpdated').textContent = `Last update · ${timeLabel} WIB`;
      state.liveLabels.push(timeLabel); state.avgVoltageLive.push(+avgV.toFixed(2)); state.avgCurrentLive.push(+avgA.toFixed(2));
      if (state.liveLabels.length > MAX_LIVE_POINTS) { state.liveLabels.shift(); state.avgVoltageLive.shift(); state.avgCurrentLive.shift(); }
      const live = state.charts.avgLiveChart;
      live.data.labels = state.liveLabels;
      live.data.datasets[0].data = state.avgVoltageLive;
      live.data.datasets[1].data = state.avgCurrentLive;
      live.update('none');
      const hourly = state.charts.hourlyDropChart;
      hourly.data.datasets.forEach((ds, i) => { ds.data = state.hourlyDrop.map(row => row[i]); });
      hourly.update('none');
      const daily = state.charts.dailyDropChart;
      daily.data.datasets.forEach((ds, i) => { ds.data = state.dailyDrop.map(row => row[i]); });
      daily.update('none');
    }

    function makeDemoMaintenance() {
      const existing = safeStorageRead();
      if (existing !== null) return existing;
      // Catatan berlabel DEMO hanya untuk memperlihatkan tampilan laporan saat pertama dibuka.
      const examples = [
        {days:8, message:'Pemeriksaan terminal kabel dan kekencangan koneksi panel.', demo:true},
        {days:37, message:'Pengecekan sensor PZEM channel 2 dan verifikasi pembacaan arus.', demo:true},
        {days:66, message:'Pembersihan panel kontrol serta inspeksi kondisi ventilasi.', demo:true},
        {days:102, message:'Pemeriksaan berkala kontaktor dan jalur suplai mesin.', demo:true},
        {days:151, message:'Verifikasi tegangan input dan pemeriksaan konektor komunikasi.', demo:true},
        {days:224, message:'Pemeriksaan sistem proteksi dan dokumentasi kondisi mesin.', demo:true}
      ];
      return examples.map((e, i) => ({id:'demo-'+i, timestamp:new Date(nowCorrected().getTime()-e.days*86400000).toISOString(), message:e.message, demo:true}));
    }
    function safeStorageRead() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw === null ? null : JSON.parse(raw);
      } catch (error) { return null; }
    }
    function saveMaintenance() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.maintenance)); return true; }
      catch (error) { showToast('Catatan tampil, tetapi browser tidak mengizinkan penyimpanan lokal.'); return false; }
    }
    function renderMaintenance() {
      const sorted = [...state.maintenance].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
      $('maintenanceCount').textContent = `${sorted.length} records`;
      $('maintenanceTableBody').innerHTML = sorted.slice(0,30).map(item => {
        const date = new Date(item.timestamp);
        const parts = nowPartsJakarta(date);
        const dateText = new Intl.DateTimeFormat('id-ID',{timeZone:'Asia/Jakarta',day:'2-digit',month:'short',year:'numeric'}).format(date);
        const timeText = `${parts.hour}:${parts.minute} WIB`;
        const message = escapeHtml(item.message);
        return `<tr><td><div class="record-date">${dateText}</div><div class="record-time">${timeText}</div></td><td><div class="record-message">${message}</div>${item.demo ? '<span class="record-tag">RECORD BY karyawan magang</span>' : '<span class="record-tag" style="color:#13845f;background:#e8fbf3">TERSIMPAN</span>'}</td></tr>`;
      }).join('');
      $('maintenanceEmpty').hidden = sorted.length > 0;
      const chartCounts = Array(12).fill(0);
      const today = nowCorrected();
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth()-11, 1, 0));
      state.maintenance.forEach(item => {
        const d = new Date(item.timestamp);
        // Batasi grafik ke 12 bulan kalender terakhir.
        const monthsDiff = (d.getUTCFullYear()-start.getUTCFullYear())*12 + (d.getUTCMonth()-start.getUTCMonth());
        if (monthsDiff >= 0 && monthsDiff < 12) chartCounts[monthsDiff]++;
      });
      const chart = state.charts.maintenanceChart;
      chart.data.datasets[0].data = chartCounts;
      chart.update();
    }
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }
    let toastTimeout;
    function showToast(message) {
      const toast = $('toast'); toast.textContent = message; toast.classList.add('show');
      clearTimeout(toastTimeout); toastTimeout = setTimeout(() => toast.classList.remove('show'), 3300);
    }
    function openModal() {
      $('maintenanceDate').value = localDatetimeValue();
      $('maintenanceMessage').value = '';
      $('maintenanceModal').classList.add('open');
      setTimeout(() => $('maintenanceMessage').focus(), 80);
    }
    function closeModal() { $('maintenanceModal').classList.remove('open'); }
    function bindEvents() {
      $('openMaintenanceBtn').addEventListener('click', openModal);
      $('openMaintenanceBtn2').addEventListener('click', openModal);
      $('closeModalBtn').addEventListener('click', closeModal);
      $('cancelModalBtn').addEventListener('click', closeModal);
      $('maintenanceModal').addEventListener('click', e => { if (e.target === $('maintenanceModal')) closeModal(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
      $('maintenanceForm').addEventListener('submit', e => {
        e.preventDefault();
        const dateValue = $('maintenanceDate').value;
        const message = $('maintenanceMessage').value.trim();
        if (!dateValue || !message) { showToast('Tanggal dan deskripsi maintenance wajib diisi.'); return; }
        const timestamp = parseWibInput(dateValue);
        if (!Number.isFinite(timestamp.getTime())) { showToast('Format tanggal atau waktu tidak valid.'); return; }
        state.maintenance.push({id:`maint-${Date.now()}-${Math.random().toString(16).slice(2,7)}`, timestamp:timestamp.toISOString(), message, demo:false});
        saveMaintenance(); renderMaintenance(); closeModal();
        showToast('Catatan maintenance berhasil ditambahkan ke laporan dan grafik.');
      });
    }

    function start() {
      renderMachineCards();
      seedHistory();
      initCharts();
      state.maintenance = makeDemoMaintenance();
      // Bila ini benar-benar first run, simpan contoh demo; input berikutnya tetap tersimpan.
      if (safeStorageRead() === null) saveMaintenance();
      renderMaintenance();
      bindEvents();
      updateClock();
      syncInternetTime();
      setInterval(updateClock, 1000);
      updateLiveReadings();
      setInterval(updateLiveReadings, UPDATE_INTERVAL_MS);
      setInterval(syncInternetTime, 15 * 60 * 1000);
    }

    start();
  })();
