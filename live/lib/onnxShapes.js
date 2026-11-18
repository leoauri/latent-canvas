// Fixes the symbolic dimensions of an ONNX model's graph inputs and outputs to given extents,
// editing the protobuf in place of a full parse: only the graph's input/output ValueInfos are
// rewritten, everything else (the weights) is copied through as byte ranges.
// anira's ONNX Runtime Web engine sizes each input from the file's declared shape and resolves at
// most one symbolic dimension; exports with a symbolic batch and time need both fixed.
//
// ModelProto.graph = 7; GraphProto.initializer = 5, input = 11, output = 12; TensorProto.name = 8;
// ValueInfoProto.type = 2; TypeProto.tensor_type = 1; Tensor.shape = 2; TensorShapeProto.dim = 1;
// Dimension.dim_value = 1 (varint), dim_param = 2 (string).

function readVarint(buf, p) {
  let v = 0, mul = 1, b;
  do {
    b = buf[p++];
    v += (b & 0x7f) * mul;
    mul *= 128;
  } while (b & 0x80);
  return [v, p];
}
function varint(v) {
  const out = [];
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Uint8Array.from(out);
}

/** The fields of the message in buf[start, end): { f, wt, start, vstart, vend }. */
function fields(buf, start, end) {
  const out = [];
  for (let p = start; p < end; ) {
    const [key, p1] = readVarint(buf, p);
    const f = Math.floor(key / 8), wt = key & 7;
    let vstart = p1, vend;
    if (wt === 0) vend = readVarint(buf, p1)[1];
    else if (wt === 1) vend = p1 + 8;
    else if (wt === 5) vend = p1 + 4;
    else if (wt === 2) {
      const [len, p2] = readVarint(buf, p1);
      vstart = p2;
      vend = p2 + len;
    } else throw new Error(`onnx: unsupported wire type ${wt}`);
    out.push({ f, wt, start: p, vstart, vend });
    p = vend;
  }
  return out;
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
};
const lenField = (f, bytes) => [varint(f * 8 + 2), varint(bytes.length), bytes];

/**
 * Copies the message, replacing the length-delimited fields `edit` handles: edit(field, bytes)
 * returns new bytes, or undefined to keep the field as it is.
 */
function rewrite(buf, start, end, edit) {
  const parts = [];
  for (const fl of fields(buf, start, end)) {
    const next = fl.wt === 2 ? edit(fl.f, buf.subarray(fl.vstart, fl.vend)) : undefined;
    if (next === undefined) parts.push(buf.subarray(fl.start, fl.vend));
    else parts.push(...lenField(fl.f, next));
  }
  return concat(parts);
}
const sub = (bytes, f, fn) => rewrite(bytes, 0, bytes.length, (g, b) => (g === f ? fn(b) : undefined));

/** A ValueInfo with its shape's dimensions set to `extents` where they are symbolic. */
function fixValueInfo(bytes, extents) {
  return sub(bytes, 2, (type) =>
    sub(type, 1, (tensor) =>
      sub(tensor, 2, (shape) => {
        let k = 0;
        return rewrite(shape, 0, shape.length, (f, dim) => {
          if (f !== 1) return undefined;
          const n = extents[k++];
          const symbolic = !fields(dim, 0, dim.length).some((d) => d.f === 1);
          return symbolic && Number.isInteger(n) ? concat([varint(8), varint(n)]) : undefined;
        });
      }),
    ),
  );
}

const nameOf = (bytes, nameField) => {
  const fl = fields(bytes, 0, bytes.length).find((x) => x.f === nameField && x.wt === 2);
  return fl ? new TextDecoder().decode(bytes.subarray(fl.vstart, fl.vend)) : '';
};

/**
 * The model with the symbolic dimensions of its graph inputs and outputs fixed, positionally:
 * inputs[i] and outputs[i] are the extents of the i-th graph input / output (graph inputs that
 * are initializers, as old exports list them, are skipped).
 * @param {Uint8Array} model
 * @param {{ inputs: number[][], outputs: number[][] }} extents
 */
export function fixOnnxShapes(model, { inputs, outputs }) {
  return sub(model, 7, (graph) => {
    const gf = fields(graph, 0, graph.length);
    const initializers = new Set(gf.filter((x) => x.f === 5).map((x) => nameOf(graph.subarray(x.vstart, x.vend), 8)));
    let i = 0, o = 0;
    return rewrite(graph, 0, graph.length, (f, vi) => {
      if (f === 11) return initializers.has(nameOf(vi, 1)) ? undefined : inputs[i] ? fixValueInfo(vi, inputs[i++]) : undefined;
      if (f === 12) return outputs[o] ? fixValueInfo(vi, outputs[o++]) : undefined;
      return undefined;
    });
  });
}
