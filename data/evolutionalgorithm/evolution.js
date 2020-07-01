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
        //console.log(fittest.brain, fittest.brain.copy());
        new Bird(BIRD_X, 500, fittest.brain.copy() || null);
    }
}

function getFittestBird(){
    deadBirds.sort(function(a, b){
        return a.fitness - b.fitness;
    });
    return deadBirds[deadBirds.length - 1] || new Bird(BIRD_X, 500, null);
}

function saveFittest(){

}

function loadFittest(){

}