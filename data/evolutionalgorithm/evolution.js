function giveMutateRate(chance){
    let number = random(0, 1);
    if(number <= chance){
        return random(-1, 1);
    }
    return 0;
}

function setPopulation(){
    let fittest = getFittestBird();
    birds = [];
    deadBirds = [];
    for (let i = 0; i < POPULATION_SIZE; i++) {
        new Bird(100, 500, fittest.brain || null);
    }
}

function getFittestBird(){
    deadBirds.sort(function(a, b){
        return a.fitness - b.fitness;
    });
    console.log(deadBirds);
    return deadBirds[0] || new Bird(100, 500);
}