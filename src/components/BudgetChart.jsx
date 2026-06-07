export default function BudgetChart({ chartMode, chartData, pctChartData, budgets, categoryColors, onBarClick, labelStep = 1, budgetLineLabel = 'Budget' }) {
  if (chartMode === 'bar') {
    if (!chartData || chartData.length === 0) {
      return <div style={{ fontSize: 13, color: '#999', padding: '40px 0', textAlign: 'center' }}>No spending data for budgeted categories in this period.</div>;
    }
    var maxVal = Math.max.apply(null, chartData.map(function(d) { return Math.max(d.spent, d.budget); }));
    if (maxVal === 0) maxVal = 1;
    maxVal = maxVal * 1.1; // 10% headroom

    var vw = 1000;
    var vh = 500;
    var padL = 70;
    var padR = 30;
    var padT = 30;
    var padB = 50;
    var plotW = vw - padL - padR;
    var plotH = vh - padT - padB;

    var barW = Math.floor(plotW / chartData.length) - 16;
    if (barW > 80) barW = 80;
    var budgetY = padT + plotH * (1 - chartData[0].budget / maxVal);

    // Y-axis ticks
    var yTicks = [];
    var step = Math.pow(10, Math.floor(Math.log10(maxVal))) || 1000;
    if (maxVal / step < 3) step = step / 2;
    for (var tick = 0; tick <= maxVal; tick += step) {
      yTicks.push(tick);
    }

    return (
      <div style={{ width: '100%' }}>
        <svg width="100%" viewBox={'0 0 ' + vw + ' ' + vh} style={{ display: 'block' }}>
          {/* Grid lines */}
          {yTicks.map(function(tick) {
            var y = padT + plotH * (1 - tick / maxVal);
            return (
              <g key={tick}>
                <line x1={padL} y1={y} x2={vw - padR} y2={y} stroke="#f0f0f0" strokeWidth="1" />
                <text x={padL - 8} y={y + 4} textAnchor="end" fontSize="11" fill="#999">${(tick / 1000).toFixed(tick >= 1000 ? 1 : 0)}k</text>
              </g>
            );
          })}

          {/* Budget line */}
          <line x1={padL} y1={budgetY} x2={vw - padR} y2={budgetY} stroke="#ba1a1a" strokeDasharray="8 4" strokeWidth="2" />
          <text x={vw - padR} y={budgetY - 6} textAnchor="end" fontSize="11" fontWeight="600" fill="#ba1a1a">{budgetLineLabel}: ${chartData[0].budget.toLocaleString()}</text>

          {/* Bars */}
          {chartData.map(function(d, i) {
            var groupW = plotW / chartData.length;
            var x = padL + i * groupW + (groupW - barW) / 2;
            var h = Math.round((d.spent / maxVal) * plotH);
            var y = padT + plotH - h;
            // With many bars (e.g. 26 weeks) thin out labels to avoid overlap; always label the last bar.
            var showLabel = labelStep <= 1 || i % labelStep === 0 || i === chartData.length - 1;
            return (
              <g key={d.month} style={{ cursor: onBarClick ? 'pointer' : 'default' }} onClick={function() { if (onBarClick) onBarClick(d.month); }}>
                <rect x={x} y={y} width={barW} height={h} rx="6" fill="#0058be" opacity="0.85" />
                <rect x={x} y={y} width={barW} height={h} rx="6" fill="#0058be" opacity="0" stroke="none">
                  <animate attributeName="opacity" from="0" to="0.15" dur="0.15s" begin="mouseover" fill="freeze" />
                  <animate attributeName="opacity" from="0.15" to="0" dur="0.15s" begin="mouseout" fill="freeze" />
                </rect>
                {showLabel && <text x={x + barW / 2} y={padT + plotH + 20} textAnchor="middle" fontSize="12" fill="#666">{d.label}</text>}
                {showLabel && <text x={x + barW / 2} y={y - 8} textAnchor="middle" fontSize="11" fontWeight="600" fill="#333">${Math.round(d.spent).toLocaleString()}</text>}
              </g>
            );
          })}
        </svg>
      </div>
    );
  }

  // Percent mode — line chart
  if (!pctChartData || pctChartData.length === 0) {
    return <div style={{ fontSize: 13, color: '#999', padding: '40px 0', textAlign: 'center' }}>No spending data for budgeted categories in this period.</div>;
  }

  var maxPct = 100;
  for (var i = 0; i < pctChartData.length; i++) {
    for (var j = 0; j < budgets.length; j++) {
      var val = pctChartData[i][budgets[j].name] || 0;
      if (val > maxPct) maxPct = val;
    }
  }
  maxPct = Math.ceil(maxPct / 20) * 20;
  if (maxPct < 120) maxPct = 120;

  var vw2 = 1000;
  var vh2 = 500;
  var padL2 = 55;
  var padR2 = 30;
  var padT2 = 30;
  var padB2 = 60;
  var plotW2 = vw2 - padL2 - padR2;
  var plotH2 = vh2 - padT2 - padB2;

  var hundredY = padT2 + plotH2 * (1 - 100 / maxPct);

  // Y-axis ticks
  var pctTicks = [];
  for (var p = 0; p <= maxPct; p += 20) { pctTicks.push(p); }

  return (
    <div style={{ width: '100%' }}>
      <svg width="100%" viewBox={'0 0 ' + vw2 + ' ' + vh2} style={{ display: 'block' }}>
        {/* Grid */}
        {pctTicks.map(function(tick) {
          var y = padT2 + plotH2 * (1 - tick / maxPct);
          return (
            <g key={tick}>
              <line x1={padL2} y1={y} x2={vw2 - padR2} y2={y} stroke={tick === 100 ? '#ba1a1a' : '#f0f0f0'} strokeWidth={tick === 100 ? 2 : 1} strokeDasharray={tick === 100 ? '8 4' : 'none'} />
              <text x={padL2 - 8} y={y + 4} textAnchor="end" fontSize="11" fill={tick === 100 ? '#ba1a1a' : '#999'}>{tick}%</text>
            </g>
          );
        })}

        {/* X labels */}
        {pctChartData.map(function(d, i) {
          var x = padL2 + (i / (pctChartData.length - 1 || 1)) * plotW2;
          var showLabel = labelStep <= 1 || i % labelStep === 0 || i === pctChartData.length - 1;
          if (!showLabel) return null;
          return <text key={d.month} x={x} y={padT2 + plotH2 + 22} textAnchor="middle" fontSize="12" fill="#666">{d.label}</text>;
        })}

        {/* Lines per budget */}
        {budgets.map(function(b, bi) {
          var lineColor = b.color || categoryColors[bi % categoryColors.length];
          var points = [];
          var circles = [];
          for (var k = 0; k < pctChartData.length; k++) {
            var xPos = padL2 + (k / (pctChartData.length - 1 || 1)) * plotW2;
            var pctVal = pctChartData[k][b.name] || 0;
            var yPos = padT2 + plotH2 * (1 - pctVal / maxPct);
            points.push(xPos + ',' + yPos);
            circles.push({ x: xPos, y: yPos, val: pctVal });
          }
          return (
            <g key={b.id}>
              <polyline points={points.join(' ')} fill="none" stroke={lineColor} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
              {circles.map(function(c, ci) {
                return (
                  <g key={ci}>
                    <circle cx={c.x} cy={c.y} r="5" fill="white" stroke={lineColor} strokeWidth="2.5" />
                    <title>{b.name}: {c.val}%</title>
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* Legend */}
        {budgets.map(function(b, bi) {
          var lx = padL2 + bi * 120;
          var ly = vh2 - 10;
          var lineColor = b.color || categoryColors[bi % categoryColors.length];
          return (
            <g key={'leg-' + b.id}>
              <rect x={lx} y={ly - 4} width="14" height="4" rx="2" fill={lineColor} />
              <text x={lx + 18} y={ly} fontSize="11" fill="#666">{b.name}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
