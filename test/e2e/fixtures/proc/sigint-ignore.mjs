// Ignores Ctrl+C: only the tree kill after the grace period ends it.
process.on('SIGINT', () => console.log('ignorando SIGINT'))
console.log('rodando e ignorando Ctrl+C')
setInterval(() => {}, 1000)
