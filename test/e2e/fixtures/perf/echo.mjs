// Key-echo fixture: stdin in raw mode, every byte straight back to stdout, no line buffering.
process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.on('data', (chunk) => { process.stdout.write(chunk) })
process.stdout.write('ECHO-READY\r\n')
