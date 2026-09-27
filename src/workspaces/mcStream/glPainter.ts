/**
 * 用 WebGL 把 RGBA8 raw 原样贴到 canvas（NEAREST，关闭颜色空间转换）。
 * 避免 2D putImageData 在部分 WebView 上的色差 / 隐式处理。
 */

export type StreamPaintOptions = {
  /** 1 = 原样；>1 压暗（更接近部分本机 GL 窗）；<1 提亮 */
  gamma?: number
}

export class StreamGlPainter {
  readonly canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext | null = null
  private prog: WebGLProgram | null = null
  private tex: WebGLTexture | null = null
  private buf: WebGLBuffer | null = null
  private uGamma: WebGLUniformLocation | null = null
  private ready = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
  }

  private ensure(): boolean {
    if (this.ready) return true
    const gl =
      this.canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      }) ||
      this.canvas.getContext('experimental-webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      })
    if (!gl) return false
    this.gl = gl as WebGLRenderingContext

    const vsSrc = `
      attribute vec2 aPos;
      attribute vec2 aUv;
      varying vec2 vUv;
      void main() {
        vUv = aUv;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `
    const fsSrc = `
      precision mediump float;
      varying vec2 vUv;
      uniform sampler2D uTex;
      uniform float uGamma;
      void main() {
        vec4 c = texture2D(uTex, vUv);
        // A 固定不透明；gamma!=1 时只调 RGB
        if (uGamma != 1.0) {
          c.rgb = pow(clamp(c.rgb, 0.0, 1.0), vec3(uGamma));
        }
        gl_FragColor = vec4(c.rgb, 1.0);
      }
    `

    const vs = this.compile(gl.VERTEX_SHADER, vsSrc)
    const fs = this.compile(gl.FRAGMENT_SHADER, fsSrc)
    if (!vs || !fs) return false
    const prog = gl.createProgram()
    if (!prog) return false
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false
    this.prog = prog

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    // clip-space 全屏三角带：pos.xy, uv.xy — UV 顶向下与 raw 一致
    // prettier-ignore
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1, 0, 1,
         1, -1, 1, 1,
        -1,  1, 0, 0,
         1,  1, 1, 0,
      ]),
      gl.STATIC_DRAW,
    )
    this.buf = buf

    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.tex = tex

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0)
    if (gl.UNPACK_COLORSPACE_CONVERSION_WEBGL !== undefined) {
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    }

    this.uGamma = gl.getUniformLocation(prog, 'uGamma')
    this.ready = true
    return true
  }

  private compile(type: number, src: string): WebGLShader | null {
    const gl = this.gl!
    const sh = gl.createShader(type)
    if (!sh) return null
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh)
      return null
    }
    return sh
  }

  draw(
    pixels: Uint8Array,
    width: number,
    height: number,
    opts: StreamPaintOptions = {},
  ): boolean {
    if (!this.ensure()) return false
    const gl = this.gl!
    const prog = this.prog!
    const gamma = opts.gamma ?? 1

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    gl.viewport(0, 0, width, height)

    gl.useProgram(prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    const aPos = gl.getAttribLocation(prog, 'aPos')
    const aUv = gl.getAttribLocation(prog, 'aUv')
    gl.enableVertexAttribArray(aPos)
    gl.enableVertexAttribArray(aUv)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    )
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0)
    if (this.uGamma) gl.uniform1f(this.uGamma, gamma)

    gl.disable(gl.BLEND)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    return true
  }

  dispose() {
    const gl = this.gl
    if (!gl) return
    if (this.tex) gl.deleteTexture(this.tex)
    if (this.buf) gl.deleteBuffer(this.buf)
    if (this.prog) gl.deleteProgram(this.prog)
    this.gl = null
    this.ready = false
  }
}
