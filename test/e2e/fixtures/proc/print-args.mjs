// Prints its arguments as JSON (proves a .cmd shortcut passes "a b" as one argument), then stays alive.
console.log(`ARGS ${JSON.stringify(process.argv.slice(2))}`)
setInterval(() => {}, 1000)
