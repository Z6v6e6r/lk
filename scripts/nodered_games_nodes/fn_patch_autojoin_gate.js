const ctx = msg._gamePatchCas && typeof msg._gamePatchCas === "object"
  ? msg._gamePatchCas
  : null;
return ctx?.required ? null : msg;
