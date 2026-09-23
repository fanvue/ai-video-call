# Image-build step: fp16 copy of an ONNX model (GFPGAN, xseg) with float32 IO. Usage: python onnx_fp16.py src.onnx dst.onnx
import sys


# Sum-of-squares norms stay fp32: GFPGAN's weight demodulation (Pow -> ReduceSum -> Add -> Sqrt -> Div) reached 2.9e6 on a real crop, past fp16's 65504, and a plain conversion measured 13 dB PSNR against fp32. xseg's FRN (x*x -> GlobalAveragePool -> Add -> Sqrt -> Reciprocal) has the same shape.
def norm_nodes(graph) -> list[str]:
    consumers: dict[str, list] = {}
    for node in graph.node:
        for name in node.input:
            consumers.setdefault(name, []).append(node)
    blocked = []
    frontier = [node for node in graph.node if node.op_type == "Pow" or (node.op_type == "Mul" and len(set(node.input)) == 1)]
    while frontier:
        node = frontier.pop()
        if node.name in blocked:
            continue
        blocked.append(node.name)
        if node.op_type in ("Div", "Reciprocal"):
            continue
        for output in node.output:
            frontier.extend(n for n in consumers.get(output, []) if n.op_type in ("ReduceSum", "GlobalAveragePool", "Add", "Sqrt", "Div", "Reciprocal"))
    return blocked


# The converter wraps each blocked node in its own casts, so a fp32 chain still round-trips through fp16 between nodes (ReduceSum 81259 -> inf); drop every fp16 Cast that only feeds a Cast back to fp32.
def drop_cast_round_trips(graph) -> int:
    from onnx import TensorProto

    producer = {output: node for node in graph.node for output in node.output}
    consumers: dict[str, list] = {}
    for node in graph.node:
        for name in node.input:
            consumers.setdefault(name, []).append(node)
    graph_outputs = {output.name for output in graph.output}

    def cast_to(node):
        return next((a.i for a in node.attribute if a.name == "to"), None) if node.op_type == "Cast" else None

    dropped = []
    for node in list(graph.node):
        if cast_to(node) != TensorProto.FLOAT:
            continue
        down = producer.get(node.input[0])
        if down is None or cast_to(down) != TensorProto.FLOAT16 or down.output[0] in graph_outputs:
            continue
        source = producer.get(down.input[0])
        if source is None or source.op_type == "Cast":
            continue
        for consumer in consumers.get(node.output[0], []):
            consumer.input[:] = [down.input[0] if name == node.output[0] else name for name in consumer.input]
        dropped.append(node)
    for node in dropped:
        graph.node.remove(node)
    return len(dropped)


def convert(source: str, target: str) -> None:
    import onnx
    from onnxruntime.transformers.float16 import convert_float_to_float16

    model = onnx.load(source)
    model = convert_float_to_float16(model, keep_io_types=True, node_block_list=norm_nodes(model.graph))
    print("fp16 cast round trips dropped:", drop_cast_round_trips(model.graph))
    onnx.save(model, target)


if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2])
