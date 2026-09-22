// How units become pixels on screen. One renderer per image method.
//
// Both renderers answer the same three questions, so the viewer does not care which is in
// use: turn these bytes into something drawable, draw everything held, and release it.
//
//   TileRenderer   JPEG units -> ImageBitmap, drawn with the 2D canvas
//   SplatRenderer  .splat units -> GPU buffers, drawn as Gaussian blobs in WebGL
//
// A canvas can only ever have one kind of context, so the viewer throws the canvas away and
// makes a new one when the method changes.

// ---------------------------------------------------------------------------- tiles

export class TileRenderer {
  static handles(method) {
    return method.startsWith('ladder-tiles');
  }

  constructor(canvas, chart) {
    this.canvas = canvas;
    this.chart = chart;
    this.ctx = canvas.getContext('2d', { alpha: false });
  }

  async decode(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: this.chart.contentType }));
    return { bitmap, width: bitmap.width, height: bitmap.height, bytes: bitmap.width * bitmap.height * 4 };
  }

  free(handle) {
    handle.bitmap.close?.();
  }

  /** Coarse levels first, finer over the top; never a hole, only a soft patch. */
  draw(scene, units) {
    const ctx = this.ctx;
    ctx.fillStyle = '#0b0c0f';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const region = scene.region();
    let drawn = 0;
    for (const unit of units) {
      const ls = scene.levelScale(unit.level);
      const size = this.chart.unitSize * ls;
      const x = (unit.x * size - region.x) / scene.camera.scale;
      const y = (unit.y * size - region.y) / scene.camera.scale;
      const w = (unit.handle.width * ls) / scene.camera.scale;
      const h = (unit.handle.height * ls) / scene.camera.scale;
      if (x + w < 0 || y + h < 0 || x > this.canvas.width || y > this.canvas.height) continue;
      ctx.drawImage(unit.handle.bitmap, x, y, w, h);
      unit.used = scene.touch();
      drawn++;
    }
    return drawn;
  }
}

// ---------------------------------------------------------------------------- splats
//
// Blobs are not drawn straight to the screen. They accumulate into an off-screen float
// buffer - weighted colour in RGB, total weight in alpha - and one final pass turns that into
// the picture. That is what both kinds of unit need:
//
//   additive (SPL1)    the pixel is the summed light: RGB as it is
//   normalised (SPLN)  the pixel is the weighted average of its blobs: RGB / alpha, which
//                      cannot overshoot white, so there are no bright speckles
//
// Each unit first clears its own rectangle and then accumulates into it. Units are drawn
// coarse to fine, so a finer unit replaces the coarser one under it instead of adding to it -
// adding would double the light wherever two levels overlap while a zoom is loading.

const BLOB_VERTEX = `#version 300 es
precision highp float;

// One quad per splat, in the splat's own rotated frame, big enough to hold its reach.
layout(location = 0) in vec2 corner;      // (-1,-1) .. (1,1)
layout(location = 1) in vec2 centre;      // splat centre, in unit pixels
layout(location = 2) in vec2 sigma;       // radii, in unit pixels
layout(location = 3) in float theta;      // rotation
layout(location = 4) in vec3 colour;      // already multiplied by amplitude

uniform vec2 uOffset;                     // where this unit's origin lands, in screen pixels
uniform float uScale;                     // unit pixels -> screen pixels
uniform vec2 uViewport;                   // canvas size, in pixels

out vec2 vOffset;                         // from the centre, in unit pixels, splat's own frame
out vec2 vSigma;
out float vReach;
out vec3 vColour;

// Both must match tools/fit_splats.py: a blob reaches CUTOFF sigma or MIN_REACH pixels,
// whichever is further, in the fitter and here alike.
const float CUTOFF = 3.0;
const float MIN_REACH = 8.0;

void main() {
  float reach = max(CUTOFF * max(sigma.x, sigma.y), MIN_REACH);
  vOffset = corner * reach;
  vSigma = sigma;
  vReach = reach;
  vColour = colour;

  float c = cos(theta), s = sin(theta);
  vec2 rotated = vec2(vOffset.x * c - vOffset.y * s, vOffset.x * s + vOffset.y * c);
  // The fitter samples unit pixel i at coordinate i; on screen that pixel's centre is i + 0.5.
  vec2 screen = uOffset + (centre + 0.5 + rotated) * uScale;

  gl_Position = vec4((screen / uViewport) * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
}`;

const BLOB_FRAGMENT = `#version 300 es
precision highp float;

in vec2 vOffset;
in vec2 vSigma;
in float vReach;
in vec3 vColour;
uniform float uNormalized;
out vec4 fragment;

void main() {
  if (dot(vOffset, vOffset) > vReach * vReach) discard;
  vec2 q = vOffset / vSigma;
  float weight = exp(-0.5 * dot(q, q));
  // weighted colour, plus the weight itself so the final pass can divide by it
  fragment = vec4(vColour * weight, uNormalized > 0.5 ? weight : 0.0);
}`;

const RESOLVE_VERTEX = `#version 300 es
out vec2 vUV;
void main() {
  // one triangle that covers the whole screen
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUV = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// Alpha doubles as a marker of what was drawn: the buffer starts at -1 (nothing), a
// normalised unit clears its rectangle to 0 and adds weights on top, an additive unit clears
// to -2 and adds none. The divide is the fitter's own: colour / max(weight, 1e-4).
const RESOLVE_FRAGMENT = `#version 300 es
precision highp float;

in vec2 vUV;
uniform sampler2D uAccumulated;
out vec4 fragment;

const vec3 BACKGROUND = vec3(0.043, 0.047, 0.06);

void main() {
  vec4 sum = texture(uAccumulated, vUV);
  if (sum.a < -1.5) {
    fragment = vec4(clamp(sum.rgb, 0.0, 1.0), 1.0);                         // additive unit
  } else if (sum.a < -0.5) {
    fragment = vec4(BACKGROUND, 1.0);                                       // nothing here
  } else {
    fragment = vec4(clamp(sum.rgb / max(sum.a, 1e-4), 0.0, 1.0), 1.0);      // normalised unit
  }
}`;

const NOTHING = -1, NORMALISED = 0, ADDITIVE = -2;   // alpha each area starts from

const MAGIC_ADDITIVE = 0x53504c31;     // "SPL1"
const MAGIC_NORMALIZED = 0x53504c4e;   // "SPLN"
const RECORD = 11;
const SIGMA_MIN = 0.6, SIGMA_MAX = 64.0;
const AMP_MIN = 1e-4, AMP_MAX = 4.0;
const POS_MARGIN = 64.0;

/** Unpack a .splat unit into the arrays WebGL wants. Mirrors tools/fit_splats.py. */
export function decodeSplats(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0);
  if (magic !== MAGIC_ADDITIVE && magic !== MAGIC_NORMALIZED) throw new Error('not a splat unit');
  const count = view.getUint16(4);
  const width = view.getUint16(6);
  const height = view.getUint16(8);

  const centre = new Float32Array(count * 2);
  const sigma = new Float32Array(count * 2);
  const theta = new Float32Array(count);
  const colour = new Float32Array(count * 3);

  const loX = -POS_MARGIN, hiX = (width - 1) + POS_MARGIN;
  const loY = -POS_MARGIN, hiY = (height - 1) + POS_MARGIN;
  const logSigma = Math.log(SIGMA_MAX / SIGMA_MIN);
  const logAmp = Math.log(AMP_MAX / AMP_MIN);

  for (let i = 0; i < count; i++) {
    const at = 10 + i * RECORD;
    centre[i * 2] = loX + view.getUint16(at) * (hiX - loX) / 65535;
    centre[i * 2 + 1] = loY + view.getUint16(at + 2) * (hiY - loY) / 65535;
    sigma[i * 2] = SIGMA_MIN * Math.exp((view.getUint8(at + 4) / 255) * logSigma);
    sigma[i * 2 + 1] = SIGMA_MIN * Math.exp((view.getUint8(at + 5) / 255) * logSigma);
    theta[i] = (view.getUint8(at + 6) / 255) * Math.PI;
    const amp = AMP_MIN * Math.exp((view.getUint8(at + 10) / 255) * logAmp);
    colour[i * 3] = (view.getInt8(at + 7) / 127) * amp;
    colour[i * 3 + 1] = (view.getInt8(at + 8) / 127) * amp;
    colour[i * 3 + 2] = (view.getInt8(at + 9) / 127) * amp;
  }
  return {
    count, width, height, centre, sigma, theta, colour,
    normalized: magic === MAGIC_NORMALIZED, bytes: bytes.byteLength,
  };
}

export class SplatRenderer {
  static handles(method) {
    return method.startsWith('splats');
  }

  constructor(canvas, chart) {
    this.canvas = canvas;
    this.chart = chart;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('this browser has no WebGL2, which the splat method needs');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('this browser cannot draw into float buffers (EXT_color_buffer_float)');
    }
    // Faint blob tails matter once colour is divided by weight, and 16-bit floats flush them
    // to zero, so 32-bit accumulation is used whenever the browser allows blending into it.
    this.floatBlend = !!gl.getExtension('EXT_float_blend');
    if (!this.floatBlend) console.warn('no EXT_float_blend: splats accumulate in 16-bit, faint edges may drop out');
    this.gl = gl;

    this.blob = link(gl, BLOB_VERTEX, BLOB_FRAGMENT);
    this.uOffset = gl.getUniformLocation(this.blob, 'uOffset');
    this.uScale = gl.getUniformLocation(this.blob, 'uScale');
    this.uViewport = gl.getUniformLocation(this.blob, 'uViewport');
    this.uNormalized = gl.getUniformLocation(this.blob, 'uNormalized');
    this.resolve = link(gl, RESOLVE_VERTEX, RESOLVE_FRAGMENT);
    this.uAccumulated = gl.getUniformLocation(this.resolve, 'uAccumulated');
    this.emptyVao = gl.createVertexArray();

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.disable(gl.DEPTH_TEST);

    this.target = null;           // {framebuffer, texture, width, height}
    this.splatsDrawn = 0;
  }

  /** The float buffer blobs accumulate into, rebuilt when the canvas changes size. */
  accumulation(width, height) {
    const gl = this.gl;
    if (this.target && this.target.width === width && this.target.height === height) return this.target;
    if (this.target) {
      gl.deleteFramebuffer(this.target.framebuffer);
      gl.deleteTexture(this.target.texture);
    }
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, this.floatBlend ? gl.RGBA32F : gl.RGBA16F, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('could not create the float buffer the splat renderer draws into');
    }
    this.target = { framebuffer, texture, width, height };
    return this.target;
  }

  async decode(bytes) {
    const splats = decodeSplats(bytes);
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const buffers = [];
    const attribute = (index, size, data) => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, size, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(index, 1);          // one value per splat, not per vertex
      buffers.push(buffer);
    };
    attribute(1, 2, splats.centre);
    attribute(2, 2, splats.sigma);
    attribute(3, 1, splats.theta);
    attribute(4, 3, splats.colour);
    gl.bindVertexArray(null);

    return {
      vao, buffers, count: splats.count, width: splats.width, height: splats.height,
      normalized: splats.normalized,
      bytes: splats.bytes,      // what the page holds: the records, not a bitmap
    };
  }

  free(handle) {
    const gl = this.gl;
    gl.deleteVertexArray(handle.vao);
    for (const buffer of handle.buffers) gl.deleteBuffer(buffer);
  }

  draw(scene, units) {
    const gl = this.gl;
    const { width, height } = this.canvas;
    const target = this.accumulation(width, height);

    // 1. accumulate every unit's blobs into the float buffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, NOTHING);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.blob);
    gl.uniform2f(this.uViewport, width, height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);         // light and weight add up; order does not matter
    gl.enable(gl.SCISSOR_TEST);

    const region = scene.region();
    let drawn = 0;
    this.splatsDrawn = 0;
    for (const unit of units) {
      const ls = scene.levelScale(unit.level);
      const k = ls / scene.camera.scale;                  // unit pixels -> screen pixels
      const originX = (unit.x * this.chart.unitSize * ls - region.x) / scene.camera.scale;
      const originY = (unit.y * this.chart.unitSize * ls - region.y) / scene.camera.scale;
      const w = unit.handle.width * k;
      const h = unit.handle.height * k;

      // Clip to this unit's own rectangle: its blobs reach past its edge on purpose, and the
      // neighbour draws that strip from its own fit. Both edges round the same way, so
      // neighbouring rectangles meet exactly instead of overlapping by a pixel.
      const x0 = Math.max(0, Math.round(originX));
      const y0 = Math.max(0, Math.round(originY));
      const x1 = Math.min(width, Math.round(originX + w));
      const y1 = Math.min(height, Math.round(originY + h));
      if (x1 <= x0 || y1 <= y0) continue;
      gl.scissor(x0, height - y1, x1 - x0, y1 - y0);      // WebGL counts y from the bottom
      // replace any coarser unit beneath, and mark which kind of unit lives here
      gl.clearColor(0, 0, 0, unit.handle.normalized ? NORMALISED : ADDITIVE);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.uniform2f(this.uOffset, originX, originY);
      gl.uniform1f(this.uScale, k);
      gl.uniform1f(this.uNormalized, unit.handle.normalized ? 1 : 0);
      gl.bindVertexArray(unit.handle.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, unit.handle.count);
      unit.used = scene.touch();
      this.splatsDrawn += unit.handle.count;
      drawn++;
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);

    // 2. turn the sums into the picture on screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.resolve);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.uniform1i(this.uAccumulated, 0);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    return drawn;
  }
}

function link(gl, vertexSource, fragmentSource) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

export function rendererFor(method, canvas, chart) {
  for (const Renderer of [TileRenderer, SplatRenderer]) {
    if (Renderer.handles(method)) return new Renderer(canvas, chart);
  }
  throw new Error(`no renderer for image method "${method}"`);
}
