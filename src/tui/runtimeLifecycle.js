export function formatFatalError(reason, source = 'fatal error') {
  const detail = reason instanceof Error
    ? (reason.stack || reason.message)
    : String(reason ?? 'Unknown error');
  return `Axion ${source}:\n${detail}`;
}

export function installFatalHandlers({
  processLike = process,
  onFatal = () => {},
  exit = (code) => processLike.exit(code),
} = {}) {
  let handling = false;
  const handle = (reason, source) => {
    if (handling) return;
    handling = true;
    try { onFatal({ reason, source, message: formatFatalError(reason, source) }); } catch {}
    exit(1);
  };
  const onUncaughtException = (reason) => handle(reason, 'crashed');
  const onUnhandledRejection = (reason) => handle(reason, 'stopped after an unhandled promise rejection');

  processLike.on('uncaughtException', onUncaughtException);
  processLike.on('unhandledRejection', onUnhandledRejection);

  return () => {
    processLike.off('uncaughtException', onUncaughtException);
    processLike.off('unhandledRejection', onUnhandledRejection);
  };
}

