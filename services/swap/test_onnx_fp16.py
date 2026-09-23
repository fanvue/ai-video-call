# The fp16 export keeps sum-of-squares norms in fp32 end to end; CPU only, needs onnx + onnxruntime.
# Run: cd services/swap && ../../.venv-fal/bin/python -m unittest -v test_onnx_fp16
import os
import tempfile
import unittest

try:
    import numpy as np
    import onnx
    import onnxruntime
    from onnx import TensorProto, helper, numpy_helper

    import onnx_fp16
except ImportError as error:  # pragma: no cover - plain-python runs skip these.
    onnx = None
    SKIP_REASON = f"needs onnx + onnxruntime: {error}"
else:
    SKIP_REASON = ""


def demod_model():
    # y = x * w / sqrt(sum((x * w)^2) + eps): GFPGAN's demodulation shape, with sums far past fp16's 65504.
    nodes = [
        helper.make_node("Mul", ["x", "w"], ["xw"], name="mul"),
        helper.make_node("Pow", ["xw", "two"], ["sq"], name="pow"),
        helper.make_node("ReduceSum", ["sq", "axes"], ["total"], name="sum", keepdims=1),
        helper.make_node("Add", ["total", "eps"], ["total_eps"], name="add"),
        helper.make_node("Sqrt", ["total_eps"], ["norm"], name="sqrt"),
        helper.make_node("Div", ["one", "norm"], ["inv"], name="div"),
        helper.make_node("Mul", ["xw", "inv"], ["y"], name="scale"),
    ]
    inits = [
        numpy_helper.from_array(np.full((1, 64), 3.0, np.float32), "w"),
        numpy_helper.from_array(np.array(2.0, np.float32), "two"),
        numpy_helper.from_array(np.array([1], np.int64), "axes"),
        numpy_helper.from_array(np.array(1e-8, np.float32), "eps"),
        numpy_helper.from_array(np.array(1.0, np.float32), "one"),
    ]
    graph = helper.make_graph(
        nodes, "demod", [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 64])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, 64])], inits,
    )
    return helper.make_model(graph, opset_imports=[helper.make_opsetid("", 15)], ir_version=8)


@unittest.skipIf(onnx is None, SKIP_REASON)
class OnnxFp16Test(unittest.TestCase):
    def test_blocks_the_whole_norm_chain_but_not_the_modulation(self):
        self.assertEqual(sorted(onnx_fp16.norm_nodes(demod_model().graph)), ["add", "div", "pow", "sqrt", "sum"])

    def test_converted_norm_stays_finite_where_plain_fp16_overflows(self):
        x = np.full((1, 64), 100.0, np.float32)
        with tempfile.TemporaryDirectory() as directory:
            source, target = os.path.join(directory, "a.onnx"), os.path.join(directory, "b.onnx")
            onnx.save(demod_model(), source)
            onnx_fp16.convert(source, target)
            converted = onnx.load(target)
            (y,) = onnxruntime.InferenceSession(target, providers=["CPUExecutionProvider"]).run(None, {"x": x})
        self.assertTrue(np.isfinite(y).all())
        np.testing.assert_allclose(y, np.full((1, 64), 1 / 8.0), rtol=1e-2)
        casts = [n for n in converted.graph.node if n.op_type == "Cast"]
        # Only the IO casts and the fp16 Mul boundaries remain; nothing between two fp32 norm nodes.
        produced_by = {o: n for n in converted.graph.node for o in n.output}
        for cast in casts:
            upstream = produced_by.get(cast.input[0])
            self.assertFalse(upstream is not None and upstream.op_type == "Cast", cast.name)


if __name__ == "__main__":
    unittest.main()
