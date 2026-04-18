/* ═══════════════════════════════════════════════════════════════════════
   ANALYST UPGRADES v1.1 — Mejoras de un analista profesional
   ─────────────────────────────────────────────────────────────────────
   v1.1: hook de render más robusto, con reintentos y fallbacks.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  if (typeof runFullAnalysis !== 'function') {
    console.warn('[AnalystUpgrades] Motor base no detectado. Carga este script DESPUÉS de analisis.html');
    return;
  }

  // ════════════════════════════════════════════════════════════════
  // MEJORA #4: PESOS CORRECTOS DEL MANUAL
  // ════════════════════════════════════════════════════════════════
  const MANUAL_WEIGHTS = {
    m1: 20, m2: 15, m3: 20, m4: 10, m5: 10,
    m6: 10, m7: 10, m8: 3, m9: 2,
  };
  const MANUAL_WEIGHTS_NO_DIV = { ...MANUAL_WEIGHTS, m8: 0, m7: 13 };

  window.computeGlobalScore = function (R) {
    const m = R.modules;
    const useWeights = m.m8 && m.m8.noDividend ? MANUAL_WEIGHTS_NO_DIV : MANUAL_WEIGHTS;
    let weighted = 0, totalW = 0;
    for (const [k, w] of Object.entries(useWeights)) {
      if (!m[k] || w === 0) continue;
      weighted += m[k].score * w;
      totalW += w;
    }
    let pct = Math.round((weighted / totalW) * 100);
    if (!R.m0.passes) pct = Math.min(pct, 40);
    return pct;
  };

  // ════════════════════════════════════════════════════════════════
  // MEJORA #2: DATA SANITY CHECK
  // ════════════════════════════════════════════════════════════════
  function runDataSanity(metrics) {
    const alerts = [];
    const g = (k) => {
      const v = metrics[k];
      if (v == null) return null;
      if (typeof v === 'object' && v !== null && 'value' in v) return v.value;
      return v;
    };
    const num = (k) => {
      const raw = g(k);
      if (raw == null) return null;
      const s = String(raw).replace(/[%,$€£\s]/g, '').replace(',', '.');
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    };

    const roic = num('roic');
    const roe = num('roe');
    const gpM = num('gp_margin');
    const niM = num('ni_margin');
    const fcfToNI = num('fcf_to_ni');
    const peFwd = num('pe_fwd');
    const peLtm = num('pe_ltm');
    const revG = num('total_rev_growth');
    const epsG = num('eps_diluted_growth');

    if (roic != null && roic > 50) {
      alerts.push({ severity: 'warn', metric: 'ROIC', value: roic,
        msg: `ROIC de ${roic.toFixed(1)}% es extraordinariamente alto. Verifica: (a) goodwill neto negativo, (b) activos fuera de balance, (c) one-off en NOPAT. Los ROIC >40% sostenidos son raros fuera de tech asset-light.` });
    }
    if (roic != null && roe != null && roe < roic - 5 && roe > 0) {
      alerts.push({ severity: 'info', metric: 'ROE<ROIC', value: null,
        msg: `ROE (${roe.toFixed(1)}%) < ROIC (${roic.toFixed(1)}%). Inusual — normalmente el apalancamiento amplifica ROE. Posible: pérdidas en non-operating, minoritarios importantes, o deuda a tipo muy alto.` });
    }
    if (gpM != null && gpM > 95) {
      alerts.push({ severity: 'warn', metric: 'Gross Margin', value: gpM,
        msg: `Margen bruto de ${gpM.toFixed(1)}% es prácticamente imposible en empresas con COGS real. Verifica si la empresa reporta COGS en otra línea (OpEx), típico en SaaS mal categorizado.` });
    }
    if (niM != null && niM > 60) {
      alerts.push({ severity: 'warn', metric: 'Net Margin', value: niM,
        msg: `Margen neto del ${niM.toFixed(1)}% sugiere ganancias extraordinarias (venta de activos, cambio de impuesto diferido, deconsolidación). No extrapolar al futuro.` });
    }
    if (fcfToNI != null && (fcfToNI > 200 || fcfToNI < -50)) {
      alerts.push({ severity: 'warn', metric: 'FCF/NI', value: fcfToNI,
        msg: `FCF/NI del ${fcfToNI.toFixed(0)}% está fuera de rango normal (60-130%). Beneficio contable y caja real están desacoplados — investigar working capital, one-offs o CapEx anormal.` });
    }
    if (peFwd != null && peLtm != null && peFwd > 0 && peLtm > 0) {
      const ratio = peLtm / peFwd;
      if (ratio > 3) {
        alerts.push({ severity: 'info', metric: 'PE shift', value: ratio,
          msg: `PER LTM (${peLtm.toFixed(0)}x) es ${ratio.toFixed(1)}x el PER Fwd (${peFwd.toFixed(0)}x). El mercado anticipa salto fuerte de beneficios — tesis dependiente de proyecciones analistas.` });
      }
      if (ratio < 0.3) {
        alerts.push({ severity: 'warn', metric: 'PE shift', value: ratio,
          msg: `PER Fwd (${peFwd.toFixed(0)}x) es muy superior al LTM (${peLtm.toFixed(0)}x). Los analistas esperan CAÍDA de beneficios — señal bajista no capturada por M9.` });
      }
    }
    if (revG != null && epsG != null && Math.abs(epsG) > 200 && Math.abs(revG) < 30) {
      alerts.push({ severity: 'info', metric: 'EPS vs Rev', value: null,
        msg: `Crecimiento EPS (${epsG.toFixed(0)}%) dispar con Revenue (${revG.toFixed(0)}%). Típico de: base EPS baja, recompras agresivas, one-off fiscal. No representa crecimiento operativo subyacente.` });
    }

    return alerts;
  }

  // ════════════════════════════════════════════════════════════════
  // MEJORA #6: STRESS TEST
  // ════════════════════════════════════════════════════════════════
  function runStressTest(metrics) {
    const num = (k) => {
      const v = metrics[k];
      const raw = v && typeof v === 'object' && 'value' in v ? v.value : v;
      if (raw == null) return null;
      const n = parseFloat(String(raw).replace(/[%,$€£\s]/g, '').replace(',', '.'));
      return isNaN(n) ? null : n;
    };

    const ebitdaM = num('ebitda_margin');
    const ic = num('interest_coverage');
    const ndEbitda = num('net_debt_to_ebitda');
    const fcfM = num('fcf_margin');

    const result = { canRun: false, survives: null, details: [], verdict: 'unknown' };

    if (ebitdaM != null && ic != null && ndEbitda != null) {
      result.canRun = true;
      const ebitdaStress = 0.49;
      const icStress = ic * ebitdaStress;
      const ndEbitdaStress = ndEbitda / ebitdaStress;
      result.details.push({
        label: 'Interest Coverage stress',
        value: icStress.toFixed(1) + 'x',
        pass: icStress > 1.5,
        comment: icStress < 1 ? 'No cubre intereses en escenario adverso — riesgo de default'
               : icStress < 1.5 ? 'Cobertura crítica — poco margen'
               : icStress < 2.5 ? 'Cobertura justa — aguanta pero con presión'
               : 'Cobertura sólida — aguanta sin problema'
      });
      result.details.push({
        label: 'Net Debt/EBITDA stress',
        value: ndEbitdaStress.toFixed(1) + 'x',
        pass: ndEbitdaStress < 6,
        comment: ndEbitdaStress > 8 ? 'Apalancamiento insostenible — probable violación de covenants'
               : ndEbitdaStress > 6 ? 'Zona peligrosa — bancos exigirían refinanciación costosa'
               : ndEbitdaStress > 4 ? 'Deuda manejable pero alta — dividendos y recompras se pararían'
               : 'Apalancamiento saludable incluso en stress'
      });
      const passes = result.details.filter(d => d.pass).length;
      result.survives = passes === result.details.length;
      result.verdict = passes === result.details.length ? 'robust'
                     : passes >= 1 ? 'fragile' : 'distressed';
    } else if (fcfM != null) {
      result.canRun = true;
      const fcfMStress = fcfM - 8;
      result.details.push({
        label: 'FCF Margin stress',
        value: fcfMStress.toFixed(1) + '%',
        pass: fcfMStress > 0,
        comment: fcfMStress < -5 ? 'FCF muy negativo — quema caja rápido'
               : fcfMStress < 0 ? 'FCF ligeramente negativo — necesita línea de crédito'
               : fcfMStress < 5 ? 'FCF positivo pero ajustado'
               : 'FCF robusto incluso en stress'
      });
      result.survives = fcfMStress > 0;
      result.verdict = fcfMStress > 3 ? 'robust' : fcfMStress > 0 ? 'fragile' : 'distressed';
    }

    return result;
  }

  // ════════════════════════════════════════════════════════════════
  // MEJORA #7: CONVICCIÓN
  // ════════════════════════════════════════════════════════════════
  function computeConviction(R) {
    const m = R.modules;
    const scores = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm9']
      .filter(k => m[k]).map(k => m[k].score);
    if (m.m8 && !m.m8.noDividend) scores.push(m.m8.score);

    const strong = scores.filter(s => s >= 0.70).length;
    const borderline = scores.filter(s => s >= 0.55 && s < 0.70).length;
    const weak = scores.filter(s => s < 0.55).length;
    const total = scores.length;

    const convictionPct = Math.round(((strong * 1.0 + borderline * 0.5 - weak * 0.3) / total) * 100);
    const conviction = Math.max(0, Math.min(100, convictionPct));

    let label, color;
    if (conviction >= 75 && strong >= total * 0.6) { label = 'ALTA'; color = '#22d45a'; }
    else if (conviction >= 50) { label = 'MEDIA'; color = '#f0b429'; }
    else if (conviction >= 25) { label = 'BAJA'; color = '#f0835a'; }
    else { label = 'MUY BAJA'; color = '#f0483a'; }

    return { conviction, label, color, strong, borderline, weak, total };
  }

  // ════════════════════════════════════════════════════════════════
  // MEJORA #1 + #3: VEREDICTO CONDICIONAL
  // ════════════════════════════════════════════════════════════════
  function conditionalVerdict(R, profileId) {
    const m = R.modules;
    const ps = R.profileScores[profileId];
    if (!ps) return null;

    const pct = ps.quantScore;

    const conditions = {
      scoreHigh: pct >= 70,
      profitabilityOk: m.m1.score >= 0.60,
      qualityOk: m.m3.score >= 0.60,
      riskOk: m.m4.score >= 0.55,
      valuationOk: m.m6.score >= 0.50 || m.m7.score >= 0.55,
      noVeto: R.m0.passes,
      fvConfidenceOk: R.meta.fvConf !== 'LOW',
    };

    const strictProfiles = ['value', 'quality', 'deepvalue', 'dgi', 'defensive'];
    if (strictProfiles.includes(profileId)) {
      conditions.profitabilityOk = m.m1.score >= 0.65;
      conditions.qualityOk = m.m3.score >= 0.65;
    }
    if (['growth', 'smallcap'].includes(profileId)) {
      conditions.growthOk = m.m2.score >= 0.60;
    }

    const failed = Object.entries(conditions).filter(([_, v]) => !v).map(([k]) => k);

    let verdict, reason;
    if (!R.m0.passes) {
      verdict = 'NO COMPRAR';
      reason = 'Veto absoluto M0 activo — riesgo de pérdida permanente de capital';
    } else if (pct < 50) {
      verdict = 'NO COMPRAR';
      reason = `Score ${pct}% insuficiente. Fundamentales débiles.`;
    } else if (pct >= 70 && failed.length === 0) {
      verdict = 'COMPRAR';
      reason = `Score ${pct}% + todos los filtros de calidad superados.`;
    } else if (pct >= 70) {
      verdict = 'WATCHLIST';
      const failedLabels = failed.map(labelFailure).join(', ');
      reason = `Score ${pct}% alcanzado pero con debilidades: ${failedLabels}. No cumple los estándares para COMPRAR convencido.`;
    } else {
      verdict = 'WATCHLIST';
      reason = `Score ${pct}% — fundamentales aceptables pero no sobresalientes. Esperar mejora o mejor precio.`;
    }

    return { verdict, reason, conditions, failed };
  }

  function labelFailure(key) {
    return {
      scoreHigh: 'score <70%',
      profitabilityOk: 'rentabilidad débil (M1)',
      qualityOk: 'calidad financiera débil (M3)',
      riskOk: 'riesgo/deuda elevado (M4)',
      valuationOk: 'sin soporte de valoración (M6/M7)',
      growthOk: 'crecimiento insuficiente (M2)',
      noVeto: 'veto M0 activo',
      fvConfidenceOk: 'Fair Value con confianza LOW',
    }[key] || key;
  }

  // ════════════════════════════════════════════════════════════════
  // MEJORA #5: CHECKLIST "NO SÉ" NEUTRAL
  // ════════════════════════════════════════════════════════════════
  window.scoreChecklist = function (answers) {
    const sectionScores = {};
    const CHECKLIST = window.CHECKLIST;
    if (!CHECKLIST) { return {}; }

    for (const [sectionId, section] of Object.entries(CHECKLIST)) {
      let totalWeight = 0, weightedSum = 0, answeredCount = 0;
      section.questions.forEach(q => {
        const ans = answers[q.id];
        if (ans === 'yes') { weightedSum += 2; totalWeight += 2; answeredCount++; }
        else if (ans === 'no') { weightedSum += -2; totalWeight += 2; answeredCount++; }
      });
      const normalized = totalWeight > 0 ? (weightedSum / totalWeight + 1) / 2 : 0.5;
      sectionScores[sectionId] = {
        score: Math.max(0, Math.min(1, normalized)),
        coverage: section.questions.length > 0 ? answeredCount / section.questions.length : 0,
      };
    }

    const CHECKLIST_WEIGHTS = window.CHECKLIST_WEIGHTS;
    const profileQualScores = {};

    if (CHECKLIST_WEIGHTS) {
      for (const [profileId, weights] of Object.entries(CHECKLIST_WEIGHTS)) {
        const [w1, w2, w3, w4, w5, w6, w7, w8] = weights;
        const total = w1 + w2 + w3 + w4 + w5 + w6 + w7 + w8;
        const weighted =
          (sectionScores.s1?.score || 0.5) * w1 + (sectionScores.s2?.score || 0.5) * w2 +
          (sectionScores.s3?.score || 0.5) * w3 + (sectionScores.s4?.score || 0.5) * w4 +
          (sectionScores.s5?.score || 0.5) * w5 + (sectionScores.s6?.score || 0.5) * w6 +
          (sectionScores.s7?.score || 0.5) * w7 + (sectionScores.s8?.score || 0.5) * w8;
        profileQualScores[profileId] = weighted / total;
      }
    }

    const QUAL_VETOS = window.QUAL_VETOS || [];
    const qualVetosFired = QUAL_VETOS.filter(veto => {
      const allQs = Object.values(CHECKLIST).flatMap(s => s.questions);
      const theQ = allQs.find(q2 => {
        const qNum = parseInt(q2.id.replace(/[a-z]/gi, ''));
        return veto.q === qNum || q2.id === `s${veto.section}q${veto.q}`;
      });
      return theQ && answers[theQ.id] === 'no';
    });

    const simpleSectionScores = {};
    Object.entries(sectionScores).forEach(([k, v]) => { simpleSectionScores[k] = v.score; });

    return {
      sectionScores: simpleSectionScores,
      sectionCoverage: Object.fromEntries(Object.entries(sectionScores).map(([k, v]) => [k, v.coverage])),
      profileQualScores,
      qualVetosFired,
    };
  };

  // ════════════════════════════════════════════════════════════════
  // MEJORA #8: ALERTA SECTOR GENERAL
  // ════════════════════════════════════════════════════════════════
  function sectorFallbackWarning(R) {
    if (R.sectorKey === 'general') {
      return { severity: 'warn',
        msg: `⚠️ Sector clasificado como "general" (fallback). Los umbrales aplicados son promedios sin ajuste sectorial específico. Se recomienda clasificar manualmente el sector.` };
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════════
  // WRAPPER de runFullAnalysis
  // ════════════════════════════════════════════════════════════════
  const _origRunFullAnalysis = window.runFullAnalysis;
  window.runFullAnalysis = function (metrics, sectorData) {
    const R = _origRunFullAnalysis(metrics, sectorData);

    R.analystUpgrades = {
      dataSanity: runDataSanity(metrics),
      stressTest: runStressTest(metrics),
      conviction: computeConviction(R),
      sectorFallback: sectorFallbackWarning(R),
      conditionalVerdicts: {},
    };

    Object.keys(R.profileScores).forEach(profileId => {
      const cv = conditionalVerdict(R, profileId);
      R.analystUpgrades.conditionalVerdicts[profileId] = cv;
      if (cv) {
        R.profileScores[profileId].verdict = cv.verdict;
        R.profileScores[profileId].verdictReason = cv.reason;
        R.profileScores[profileId].verdictColor =
          cv.verdict === 'COMPRAR' ? '#22d45a' :
          cv.verdict === 'WATCHLIST' ? '#f0b429' : '#f0483a';
      }
    });

    console.log('[AnalystUpgrades] Análisis extendido ✓', R.analystUpgrades);

    // Intentar renderizar el panel (con varios intentos por si renderResults es async)
    setTimeout(() => tryRenderAnalystPanel(R), 100);
    setTimeout(() => tryRenderAnalystPanel(R), 500);
    setTimeout(() => tryRenderAnalystPanel(R), 1500);

    return R;
  };

  // ════════════════════════════════════════════════════════════════
  // RENDER del panel — estrategia robusta con múltiples fallbacks
  // ════════════════════════════════════════════════════════════════
  function tryRenderAnalystPanel(R) {
    if (!R || !R.analystUpgrades) {
      console.warn('[AnalystUpgrades] No hay datos para renderizar');
      return;
    }

    // Si ya existe, recrearlo (para refrescar datos)
    const existing = document.getElementById('analystDiagnosticPanel');
    if (existing) existing.remove();

    // ESTRATEGIA: insertar el panel DESPUÉS de #tab-reasoning como hermano,
    // no dentro de él. insertAdjacentElement('afterend') lo coloca fuera del tab.
    const tabReasoning = document.getElementById('tab-reasoning');
    const panel = document.createElement('div');
    panel.id = 'analystDiagnosticPanel';
    panel.style.cssText = `
      max-width: 1280px;
      margin: 40px auto 80px;
      padding: 0 48px;
      font-family: system-ui, -apple-system, sans-serif;
      color: #c9d1d9;
      position: relative;
      z-index: 1;
      display: block !important;
    `;
    panel.innerHTML = buildPanelHTML(R);

    if (tabReasoning) {
      tabReasoning.insertAdjacentElement('afterend', panel);
      console.log('[AnalystUpgrades] Panel renderizado ✓ (después de #tab-reasoning)');
    } else {
      document.body.appendChild(panel);
      console.log('[AnalystUpgrades] Panel renderizado ✓ (fallback: body)');
    }
  }

  // Re-enganche del hook original por si el usuario llama renderResults manualmente
  if (typeof window.renderResults === 'function') {
    const _origRenderResults = window.renderResults;
    window.renderResults = function () {
      _origRenderResults.apply(this, arguments);
      if (window.analysisResult) {
        setTimeout(() => tryRenderAnalystPanel(window.analysisResult), 100);
      }
    };
  }

  function buildPanelHTML(R) {
    const U = R.analystUpgrades;
    return `
      <style>
        #analystDiagnosticPanel *{box-sizing:border-box}
        #analystDiagnosticPanel .ap-head{
          display:flex;align-items:center;gap:12px;margin-bottom:16px;
          padding:16px 20px;
          background:linear-gradient(135deg,rgba(88,166,255,0.08),rgba(88,166,255,0.02));
          border:1px solid rgba(88,166,255,0.3);border-radius:12px;
        }
        #analystDiagnosticPanel .ap-sub{
          font-size:.72rem;color:#8b949e;letter-spacing:1px;text-transform:uppercase;
          font-weight:700;
        }
        #analystDiagnosticPanel .ap-title{
          font-size:1.2rem;font-weight:800;color:#c9d1d9;letter-spacing:-.3px;margin-top:2px;
        }
        #analystDiagnosticPanel .ap-grid{
          display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:18px;
        }
        #analystDiagnosticPanel .ap-card{
          background:rgba(255,255,255,0.03);border:1px solid #30363d;border-radius:10px;padding:14px 16px;
          border-left:3px solid #58a6ff;
        }
        #analystDiagnosticPanel .ap-card.ok{border-left-color:#22d45a}
        #analystDiagnosticPanel .ap-card.warn{border-left-color:#f0b429}
        #analystDiagnosticPanel .ap-card.bad{border-left-color:#f0483a}
        #analystDiagnosticPanel .ap-card h4{
          margin:0 0 6px;font-size:.82rem;font-weight:700;color:#c9d1d9;
        }
        #analystDiagnosticPanel .ap-val{
          font-family:ui-monospace,SFMono-Regular,monospace;font-size:1.3rem;font-weight:700;
          margin:6px 0 4px;color:#c9d1d9;
        }
        #analystDiagnosticPanel .ap-lbl{font-size:.72rem;color:#8b949e;line-height:1.5}
        #analystDiagnosticPanel .ap-alert{
          padding:10px 14px;border-radius:8px;margin-bottom:8px;
          font-size:.82rem;line-height:1.55;color:#8b949e;
        }
        #analystDiagnosticPanel .ap-alert.warn{background:rgba(240,180,41,0.08);border-left:3px solid #f0b429}
        #analystDiagnosticPanel .ap-alert.info{background:rgba(88,166,255,0.06);border-left:3px solid #58a6ff}
        #analystDiagnosticPanel .ap-alert.bad{background:rgba(240,72,58,0.08);border-left:3px solid #f0483a}
        #analystDiagnosticPanel .ap-alert strong{color:#c9d1d9;font-weight:700}
        #analystDiagnosticPanel .ap-section{margin-bottom:24px}
        #analystDiagnosticPanel .ap-section-title{
          font-size:.9rem;font-weight:700;color:#c9d1d9;margin:0 0 10px;
          display:flex;align-items:center;gap:8px;
        }
        #analystDiagnosticPanel .ap-stress-row{
          display:flex;align-items:center;justify-content:space-between;gap:12px;
          padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04);
          font-size:.8rem;
        }
        #analystDiagnosticPanel .ap-stress-row:last-child{border-bottom:none}
        #analystDiagnosticPanel .ap-stress-lbl{color:#8b949e;flex:1}
        #analystDiagnosticPanel .ap-stress-val{
          font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700;padding:2px 8px;border-radius:4px;
        }
        #analystDiagnosticPanel .ap-stress-val.ok{background:rgba(34,212,90,0.15);color:#22d45a}
        #analystDiagnosticPanel .ap-stress-val.bad{background:rgba(240,72,58,0.15);color:#f0483a}
        #analystDiagnosticPanel .ap-stress-comment{font-size:.72rem;color:#6e7681;margin-top:2px;padding:0 12px 6px}
        #analystDiagnosticPanel .ap-conviction-bar{
          height:8px;border-radius:4px;background:rgba(255,255,255,0.06);
          overflow:hidden;margin:8px 0 4px;
        }
        #analystDiagnosticPanel .ap-conviction-fill{height:100%;transition:width .6s}
      </style>

      <div class="ap-head">
        <div style="font-size:2rem;line-height:1">🔬</div>
        <div>
          <div class="ap-sub">Diagnóstico del Analista · v1.1</div>
          <div class="ap-title">Capa de validación y stress test</div>
        </div>
      </div>

      ${renderSectorFallback(U)}
      ${renderConvictionCard(U)}
      ${renderDataSanitySection(U)}
      ${renderStressTestSection(U)}
      ${renderVerdictConditionsSection(R)}
    `;
  }

  function renderSectorFallback(U) {
    if (!U.sectorFallback) return '';
    return `<div class="ap-alert warn">${U.sectorFallback.msg}</div>`;
  }

  function renderConvictionCard(U) {
    const c = U.conviction;
    if (!c) return '';
    return `
      <div class="ap-section">
        <div class="ap-section-title">📊 Convicción del Veredicto</div>
        <div class="ap-grid">
          <div class="ap-card" style="border-left-color:${c.color}">
            <h4>Índice de Convicción</h4>
            <div class="ap-val" style="color:${c.color}">${c.label} · ${c.conviction}%</div>
            <div class="ap-conviction-bar"><div class="ap-conviction-fill" style="width:${c.conviction}%;background:${c.color}"></div></div>
            <div class="ap-lbl">Dos empresas con el mismo score pueden tener convicción muy distinta. Mide cuántos módulos están realmente sólidos vs raspando.</div>
          </div>
          <div class="ap-card ok">
            <h4>✅ Módulos sólidos</h4>
            <div class="ap-val" style="color:#22d45a">${c.strong} / ${c.total}</div>
            <div class="ap-lbl">Puntuación ≥ 70% — fortaleza genuina</div>
          </div>
          <div class="ap-card warn">
            <h4>⚠️ Módulos raspando</h4>
            <div class="ap-val" style="color:#f0b429">${c.borderline} / ${c.total}</div>
            <div class="ap-lbl">55-70% — cumplen pero sin margen</div>
          </div>
          <div class="ap-card bad">
            <h4>❌ Módulos débiles</h4>
            <div class="ap-val" style="color:#f0483a">${c.weak} / ${c.total}</div>
            <div class="ap-lbl">&lt; 55% — investigar causa</div>
          </div>
        </div>
      </div>`;
  }

  function renderDataSanitySection(U) {
    const alerts = U.dataSanity || [];
    if (alerts.length === 0) {
      return `
        <div class="ap-section">
          <div class="ap-section-title">🔍 Validación de Métricas Input</div>
          <div class="ap-alert info">Sin outliers evidentes en las métricas. Datos dentro de rangos razonables. Verifica siempre los estados financieros originales para ajustes extraordinarios.</div>
        </div>`;
    }
    const html = alerts.map(a => `
      <div class="ap-alert ${a.severity === 'warn' ? 'warn' : 'info'}">
        <strong>${a.metric}${a.value != null ? ': ' + (typeof a.value === 'number' ? a.value.toFixed(2) : a.value) : ''}</strong> — ${a.msg}
      </div>
    `).join('');
    return `
      <div class="ap-section">
        <div class="ap-section-title">🔍 Validación de Métricas Input (${alerts.length} ${alerts.length === 1 ? 'alerta' : 'alertas'})</div>
        ${html}
      </div>`;
  }

  function renderStressTestSection(U) {
    const s = U.stressTest;
    if (!s || !s.canRun) {
      return `
        <div class="ap-section">
          <div class="ap-section-title">🌩️ Stress Test — Escenario Adverso</div>
          <div class="ap-alert info">No hay datos suficientes para ejecutar el stress test. Se necesitan: EBITDA Margin, Interest Coverage, Net Debt/EBITDA o FCF Margin.</div>
        </div>`;
    }
    const verdictColor = s.verdict === 'robust' ? '#22d45a' : s.verdict === 'fragile' ? '#f0b429' : '#f0483a';
    const verdictLabel = s.verdict === 'robust' ? '✅ SOBREVIVE' : s.verdict === 'fragile' ? '⚠️ FRÁGIL' : '❌ EN PELIGRO';
    const explanation = s.verdict === 'robust'
      ? 'En un escenario adverso (revenue -30%, compresión de márgenes 30%), la empresa mantiene capacidad de servicio de deuda y no viola covenants razonables.'
      : s.verdict === 'fragile'
      ? 'En escenario adverso la empresa queda ajustada — probablemente tendría que suspender dividendos, recompras o refinanciar a peores condiciones.'
      : 'En escenario adverso la empresa probablemente entraría en distress financiero: violación de covenants, necesidad de ampliación de capital dilutiva o reestructuración de deuda.';

    const rows = s.details.map(d => `
      <div>
        <div class="ap-stress-row">
          <span class="ap-stress-lbl">${d.label}</span>
          <span class="ap-stress-val ${d.pass ? 'ok' : 'bad'}">${d.value}</span>
        </div>
        <div class="ap-stress-comment">${d.comment}</div>
      </div>
    `).join('');

    return `
      <div class="ap-section">
        <div class="ap-section-title">🌩️ Stress Test — Escenario Adverso (Rev -30%, márgenes -30%)</div>
        <div class="ap-card" style="border-left-color:${verdictColor};margin-bottom:10px">
          <h4 style="color:${verdictColor}">${verdictLabel}</h4>
          <div class="ap-lbl" style="margin-top:4px">${explanation}</div>
        </div>
        <div class="ap-card">${rows}</div>
      </div>`;
  }

  function renderVerdictConditionsSection(R) {
    const scores = Object.entries(R.profileScores).map(([id, ps]) => ({ id, score: ps.quantScore }));
    scores.sort((a, b) => b.score - a.score);
    const bestProfileId = scores[0]?.id;
    if (!bestProfileId) return '';
    const cv = R.analystUpgrades.conditionalVerdicts[bestProfileId];
    if (!cv) return '';

    const conds = Object.entries(cv.conditions).map(([k, v]) => `
      <div class="ap-stress-row">
        <span class="ap-stress-lbl">${prettyCondition(k)}</span>
        <span class="ap-stress-val ${v ? 'ok' : 'bad'}">${v ? '✓' : '✗'}</span>
      </div>
    `).join('');

    const PROFILES = window.PROFILES || {};
    const pname = PROFILES[bestProfileId]?.name || bestProfileId;
    const alertCls = cv.verdict === 'COMPRAR' ? 'info' : cv.verdict === 'WATCHLIST' ? 'warn' : 'bad';

    return `
      <div class="ap-section">
        <div class="ap-section-title">🎯 Condiciones del Veredicto (perfil top: ${pname})</div>
        <div class="ap-alert ${alertCls}">
          <strong>${cv.verdict}</strong> — ${cv.reason}
        </div>
        <div class="ap-card" style="margin-top:8px">${conds}</div>
      </div>`;
  }

  function prettyCondition(key) {
    return {
      scoreHigh: 'Score global ≥ 70%',
      profitabilityOk: 'Rentabilidad (M1) ≥ 60-65%',
      qualityOk: 'Calidad financiera (M3) ≥ 60-65%',
      riskOk: 'Riesgo/deuda (M4) ≥ 55%',
      valuationOk: 'Valoración (M6 o M7) soporta el precio',
      growthOk: 'Crecimiento (M2) ≥ 60%',
      noVeto: 'Sin vetos absolutos M0',
      fvConfidenceOk: 'Fair Value Confidence ≠ LOW',
    }[key] || key;
  }

  console.log('%c[AnalystUpgrades v1.1] Cargado correctamente', 'color:#22d45a;font-weight:700');
  console.log('Mejoras activas:');
  console.log('  ✓ #1 Veredicto condicional (no threshold lineal)');
  console.log('  ✓ #2 Data sanity check (outliers)');
  console.log('  ✓ #3 FV Confidence LOW bloquea COMPRAR');
  console.log('  ✓ #4 Pesos del manual en score global');
  console.log('  ✓ #5 "No sé" = neutral en checklist');
  console.log('  ✓ #6 Stress test cuantitativo');
  console.log('  ✓ #7 Métrica de convicción');
  console.log('  ✓ #8 Alerta sector "general"');
})();
