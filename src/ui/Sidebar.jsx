import React from 'react';
import { Box, Text } from 'ink';

export const SIDEBAR_WIDTH = 28;

function SectionHead({ label, accent }) {
  return <Text color={accent} bold>{label}</Text>;
}

export function Sidebar({
  todos,
  model,
  modeIcon,
  modeLabelStr,
  modeColor,
  sessionCost,
  includedFiles,
  accent,
  ctxUsed,
  ctxWindow,
  gauge,
  mcpTools,
}) {
  const pending = todos.filter(t => !t.done);
  const done    = todos.filter(t => t.done);

  return (
    <Box
      width={SIDEBAR_WIDTH}
      flexShrink={0}
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      {/* Header */}
      <Box gap={1}>
        <Text color={accent} bold>◈</Text>
        <Text color={accent} bold>workspace</Text>
      </Box>

      {/* Model */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHead label="model" accent={accent} />
        <Text color="white" wrap="truncate">  {model}</Text>
      </Box>

      {/* Mode */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHead label="mode" accent={accent} />
        <Text color={modeColor}>  {modeIcon} {modeLabelStr}</Text>
      </Box>

      {/* Context usage */}
      {ctxUsed > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <SectionHead label="context" accent={accent} />
          <Text color="gray">  {(ctxUsed / 1000).toFixed(1)}k / {(ctxWindow / 1000).toFixed(0)}k</Text>
          {gauge && (
            <Text color={gauge.color} wrap="truncate">  {gauge.bar} {Math.round(gauge.pct * 100)}%</Text>
          )}
        </Box>
      )}

      {/* Session cost */}
      {sessionCost > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <SectionHead label="cost" accent={accent} />
          <Text color="gray">  ${sessionCost.toFixed(4)}</Text>
        </Box>
      )}

      {/* Pinned files */}
      {includedFiles.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <SectionHead label={`pinned (${includedFiles.length})`} accent={accent} />
          {includedFiles.slice(0, 4).map((f, i) => {
            const name = f.path.split(/[\\/]/).pop();
            return (
              <Text key={i} color="gray" wrap="truncate">  {name}</Text>
            );
          })}
          {includedFiles.length > 4 && (
            <Text color="gray">  +{includedFiles.length - 4} more</Text>
          )}
        </Box>
      )}

      {/* MCP tools */}
      {mcpTools > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <SectionHead label="mcp" accent={accent} />
          <Text color="gray">  {mcpTools} tools</Text>
        </Box>
      )}

      {/* Pending todos */}
      {pending.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <SectionHead label={`todo (${pending.length})`} accent={accent} />
          {pending.slice(0, 7).map(t => (
            <Text key={t.id} color="white" wrap="truncate">  ☐ {t.text}</Text>
          ))}
          {pending.length > 7 && (
            <Text color="gray">  +{pending.length - 7} more</Text>
          )}
        </Box>
      )}

      {/* Done count */}
      {done.length > 0 && pending.length > 0 && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>  {done.length} done</Text>
        </Box>
      )}
    </Box>
  );
}
