/**
 * A TCP stand-in for a Brother QL-820NWBc, shared by the bridge and e2e tests.
 *
 * It answers Brother's status request (ESC i S) with a 32-byte status block
 * and records every connection that carried a real print job.
 */
import net from 'node:net'

export function statusBlock({ mediaWidthMm = 62, error1 = 0, error2 = 0 } = {}) {
  const b = Buffer.alloc(32)
  b[0] = 0x80
  b[1] = 0x20
  b[2] = 0x42 // 'B'
  b[3] = 0x30 // '0'
  b[4] = 0x38 // model family byte
  b[8] = error1
  b[9] = error2
  b[10] = mediaWidthMm
  b[11] = 0x0a // continuous
  return b
}

export function startFakePrinter(port, options = {}) {
  const jobs = []
  let statusRequests = 0

  const server = net.createServer((socket) => {
    const chunks = []
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const all = Buffer.concat(chunks)
      if (all.length >= 205 && all.subarray(-3).equals(Buffer.from([0x1b, 0x69, 0x53]))) {
        statusRequests++
        socket.write(statusBlock(options))
      }
    })
    socket.on('close', () => {
      const all = Buffer.concat(chunks)
      // The status handshake is 205 bytes; anything bigger is a print job.
      if (all.length > 400) jobs.push(all)
    })
    socket.on('error', () => {})
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        jobs,
        get statusRequests() {
          return statusRequests
        },
        close: () => new Promise((done) => server.close(done)),
      })
    )
  })
}
