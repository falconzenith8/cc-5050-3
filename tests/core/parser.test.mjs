import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsda } from '../../src/core/usda-parser.js';

const SAMPLE = `#usda 1.0
(
    defaultPrim = "World"
    metersPerUnit = 0.01
    upAxis = "Z"
)

def Xform "World"
{
    matrix4d xformOp:transform = ((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1))
    uniform token[] xformOpOrder = ["xformOp:transform"]

    def Xform "Inst" (
        instanceable = true
        prepend references = </_Prototypes/Geo>
    )
    {
    }

    def PointInstancer "PI"
    {
        int[] protoIndices = [0, 0]
        prepend rel prototypes = </_Prototypes/Geo>
        point3f[] positions = [(1, 0, 0), (0, 2, 0)]
        quatf[] orientations = [(0, 0, 0, 1), (0, 0, 0, 1)]
        float3[] scales = [(1, 1, 1), (-1, 1, 1)]
    }

    def Mesh "M"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1)] (
            interpolation = "vertex"
        )
        texCoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)] (
            interpolation = "faceVarying"
        )
        bool doubleSided = 1
        rel material:binding = </World/M/Mat>
    }
}

class Xform "_Prototypes"
{
    class Xform "Geo"
    {
        def Mesh "Geo"
        {
            int[] faceVertexCounts = [3]
            int[] faceVertexIndices = [0, 1, 2]
            point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        }
    }
}
`;

test('reads stage metadata', () => {
  const { layer, warnings } = parseUsda(SAMPLE);
  assert.equal(warnings.length, 0);
  assert.equal(layer.metadata.defaultPrim, 'World');
  assert.equal(layer.metadata.upAxis, 'Z');
  assert.equal(layer.metadata.metersPerUnit, 0.01);
});

test('parses instanceable metadata and prepend references', () => {
  const { layer } = parseUsda(SAMPLE);
  const world = layer.prims.find((p) => p.name === 'World');
  const inst = world.prims.find((p) => p.name === 'Inst');
  assert.equal(inst.metadata.instanceable, true);
  assert.equal(inst.metadata.references.path, '/_Prototypes/Geo');
});

test('parses PointInstancer relationships with a list op', () => {
  const { layer } = parseUsda(SAMPLE);
  const pi = layer.prims.find((p) => p.name === 'World').prims.find((p) => p.name === 'PI');
  assert.equal(pi.props.prototypes.value.path, '/_Prototypes/Geo');
  assert.equal(pi.props.prototypes.listOp, 'prepend');
  assert.equal(pi.props.prototypes.rel, true);
  assert.deepEqual(pi.props.positions.value, [[1, 0, 0], [0, 2, 0]]);
  assert.deepEqual(pi.props.scales.value[1], [-1, 1, 1]);
});

test('parses typed primvars with trailing interpolation metadata', () => {
  const { layer } = parseUsda(SAMPLE);
  const m = layer.prims.find((p) => p.name === 'World').prims.find((p) => p.name === 'M');
  assert.equal(m.props['primvars:st'].meta.interpolation, 'faceVarying');
  assert.equal(m.props.normals.meta.interpolation, 'vertex');
  assert.equal(m.props.doubleSided.value, 1);
  assert.equal(m.props['material:binding'].value.path, '/World/M/Mat');
});

test('parses class prims without treating them as defs', () => {
  const { layer } = parseUsda(SAMPLE);
  const proto = layer.prims.find((p) => p.name === '_Prototypes');
  assert.equal(proto.kind, 'class');
  assert.equal(proto.prims[0].kind, 'class');
  assert.equal(proto.prims[0].prims[0].kind, 'def');
});

test('reports syntax errors with line numbers', () => {
  assert.throws(() => parseUsda('#usda 1.0\ndef Xform "A" { matrix4d x = ((1,2,3) }\n'), /line|unterminated|expected/i);
});
