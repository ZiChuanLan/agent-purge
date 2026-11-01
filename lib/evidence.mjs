// Pure evidence model shared by the Web UI and Node control plane.
// An isolated capability test is never proof about an already-running session.
const array = value => Array.isArray(value) ? value : [];
const mainRequests = mode => array(mode?.requests).filter(request => request && (request.kind === undefined || request.kind === 'main'));
export const privilegedHit = request => Number(request?.markerCount) > 0 &&
  array(request?.roles).some(role => role === 'system' || role === 'developer');
export const sysHit = result => array(result?.modes).some(mode => mainRequests(mode).some(privilegedHit));

export function captureScopeLabel(scope) {
  if (scope?.kind === 'isolated-cli') return `隔离 CLI${scope.profile ? `（${scope.profile}）` : ''}`;
  if (scope?.kind === 'isolated-session') return `隔离同会话${scope.profile ? `（${scope.profile}）` : ''}`;
  return '历史隔离测试（未记录入口）';
}

export function verificationEvidence(result) {
  const view = (state, label, kind = 'warn') => ({ state, label, kind, runtimeConfirmed: false });
  if (!result) return view('not-tested', '未实测', '');
  if (['missing', 'unavailable'].includes(result.status)) return view('unavailable', '未找到入口');
  if (result.status === 'blocked') return view('blocked', '验证受阻');
  if (result.status === 'error') return view('error', '验证出错');
  if (result.status === 'no-request') return view('no-request', '未捕获请求');
  const modes = array(result.modes);
  if (!modes.length) return view('invalid', '无有效证据');
  if (modes.some(m => m?.timedOut || (m?.exitCode !== undefined && m.exitCode !== 0) || m?.status === 'error'))
    return view('error', '验证出错');
  const hasRequests = modes.some(m => mainRequests(m).length > 0);
  if (!hasRequests) return view('no-request', '未捕获请求');
  if (modes.some(m => !mainRequests(m).length || m?.status === 'no-request'))
    return view('partial', '验证未完成');
  if (modes.every(m => m?.mode === 'off')) {
    return modes.every(m => m.status === 'captured' && mainRequests(m).every(r => r.markerCount === 0))
      ? view('off-verified', '暂停验证通过', 'blue') : view('mismatch', '暂停仍有残留');
  }
  const active = modes.filter(m => m?.mode !== 'off');
  const hits = active.flatMap(mainRequests);
  if (!hits.some(privilegedHit)) return view('miss', '请求未命中');
  if (result.status !== 'captured' || modes.some(m => m?.status !== 'captured') ||
      hits.some(r => !privilegedHit(r) || r.markerCount !== 1))
    return view('partial', '请求部分命中');
  return view('verified', '隔离测试命中', 'good');
}
